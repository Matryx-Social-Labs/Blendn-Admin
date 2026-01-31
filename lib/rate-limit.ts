import { NextRequest, NextResponse } from "next/server"

interface RateLimitEntry {
  count: number
  resetTime: number
}

// In-memory store - in production, use Redis
const rateLimitStore = new Map<string, RateLimitEntry>()

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyGenerator?: (req: NextRequest) => string
}

const DEFAULT_KEY_GENERATOR = (req: NextRequest): string => {
  const ip = req.headers.get("x-forwarded-for") ||
             req.headers.get("x-real-ip") ||
             "unknown"
  return `${req.method}:${req.nextUrl.pathname}:${ip}`
}

/**
 * Rate limiter middleware
 * Returns null if allowed, or a NextResponse if rate limited
 */
export function rateLimit(
  req: NextRequest,
  config: RateLimitConfig
): NextResponse | null {
  const { windowMs, maxRequests, keyGenerator = DEFAULT_KEY_GENERATOR } = config
  const key = keyGenerator(req)
  const now = Date.now()

  const entry = rateLimitStore.get(key)

  if (!entry || now > entry.resetTime) {
    // First request or window expired - create new entry
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    })
    return null
  }

  if (entry.count >= maxRequests) {
    // Rate limit exceeded
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000)
    return NextResponse.json(
      {
        success: false,
        error: "Too many requests",
        retryAfter,
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": entry.resetTime.toString(),
          "Retry-After": retryAfter.toString(),
        },
      }
    )
  }

  // Increment counter
  entry.count++
  return null
}

/**
 * Create a rate limit configuration for auth endpoints
 */
export function createAuthRateLimit(
  type: "signin" | "signup" | "google" | "refresh"
): RateLimitConfig {
  const configs: Record<string, RateLimitConfig> = {
    signin: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 5,
      keyGenerator: (req) => {
        const ip = req.headers.get("x-forwarded-for") ||
                   req.headers.get("x-real-ip") ||
                   "unknown"
        // Try to get email from body for stricter per-account limiting
        return `auth:signin:${ip}`
      },
    },
    signup: {
      windowMs: 60 * 60 * 1000, // 1 hour
      maxRequests: 3,
      keyGenerator: (req) => {
        const ip = req.headers.get("x-forwarded-for") ||
                   req.headers.get("x-real-ip") ||
                   "unknown"
        return `auth:signup:${ip}`
      },
    },
    google: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 10,
      keyGenerator: (req) => {
        const ip = req.headers.get("x-forwarded-for") ||
                   req.headers.get("x-real-ip") ||
                   "unknown"
        return `auth:google:${ip}`
      },
    },
    refresh: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 20,
      keyGenerator: (req) => {
        const ip = req.headers.get("x-forwarded-for") ||
                   req.headers.get("x-real-ip") ||
                   "unknown"
        return `auth:refresh:${ip}`
      },
    },
  }

  return configs[type]
}

/**
 * Clean up expired entries periodically (call this in a cron job)
 */
export function cleanupRateLimitStore(): number {
  const now = Date.now()
  let cleaned = 0

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key)
      cleaned++
    }
  }

  return cleaned
}
