"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = rateLimit;
exports.createAuthRateLimit = createAuthRateLimit;
exports.cleanupRateLimitStore = cleanupRateLimitStore;
const server_1 = require("next/server");
// In-memory store - in production, use Redis
const rateLimitStore = new Map();
const DEFAULT_KEY_GENERATOR = (req) => {
    const ip = req.headers.get("x-forwarded-for") ||
        req.headers.get("x-real-ip") ||
        "unknown";
    return `${req.method}:${req.nextUrl.pathname}:${ip}`;
};
/**
 * Rate limiter middleware
 * Returns null if allowed, or a NextResponse if rate limited
 */
function rateLimit(req, config) {
    const { windowMs, maxRequests, keyGenerator = DEFAULT_KEY_GENERATOR } = config;
    const key = keyGenerator(req);
    const now = Date.now();
    const entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetTime) {
        // First request or window expired - create new entry
        rateLimitStore.set(key, {
            count: 1,
            resetTime: now + windowMs,
        });
        return null;
    }
    if (entry.count >= maxRequests) {
        // Rate limit exceeded
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        return server_1.NextResponse.json({
            success: false,
            error: "Too many requests",
            retryAfter,
        }, {
            status: 429,
            headers: {
                "X-RateLimit-Limit": maxRequests.toString(),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": entry.resetTime.toString(),
                "Retry-After": retryAfter.toString(),
            },
        });
    }
    // Increment counter
    entry.count++;
    return null;
}
/**
 * Create a rate limit configuration for auth endpoints
 */
function createAuthRateLimit(type) {
    const configs = {
        signin: {
            windowMs: 15 * 60 * 1000, // 15 minutes
            maxRequests: 5,
            keyGenerator: (req) => {
                const ip = req.headers.get("x-forwarded-for") ||
                    req.headers.get("x-real-ip") ||
                    "unknown";
                // Try to get email from body for stricter per-account limiting
                return `auth:signin:${ip}`;
            },
        },
        signup: {
            windowMs: 60 * 60 * 1000, // 1 hour
            maxRequests: 3,
            keyGenerator: (req) => {
                const ip = req.headers.get("x-forwarded-for") ||
                    req.headers.get("x-real-ip") ||
                    "unknown";
                return `auth:signup:${ip}`;
            },
        },
        google: {
            windowMs: 15 * 60 * 1000, // 15 minutes
            maxRequests: 10,
            keyGenerator: (req) => {
                const ip = req.headers.get("x-forwarded-for") ||
                    req.headers.get("x-real-ip") ||
                    "unknown";
                return `auth:google:${ip}`;
            },
        },
        refresh: {
            windowMs: 15 * 60 * 1000, // 15 minutes
            maxRequests: 20,
            keyGenerator: (req) => {
                const ip = req.headers.get("x-forwarded-for") ||
                    req.headers.get("x-real-ip") ||
                    "unknown";
                return `auth:refresh:${ip}`;
            },
        },
    };
    return configs[type];
}
/**
 * Clean up expired entries periodically (call this in a cron job)
 */
function cleanupRateLimitStore() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of rateLimitStore.entries()) {
        if (now > entry.resetTime) {
            rateLimitStore.delete(key);
            cleaned++;
        }
    }
    return cleaned;
}
