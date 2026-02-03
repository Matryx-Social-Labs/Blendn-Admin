"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyAccessToken = verifyAccessToken;
exports.storeRefreshToken = storeRefreshToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.revokeUserRefreshTokens = revokeUserRefreshTokens;
exports.revokeRefreshToken = revokeRefreshToken;
exports.extractBearerToken = extractBearerToken;
exports.getAuthenticatedUser = getAuthenticatedUser;
exports.cleanupExpiredTokens = cleanupExpiredTokens;
exports.verifyGoogleIdToken = verifyGoogleIdToken;
exports.findOrCreateGoogleUser = findOrCreateGoogleUser;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = require("crypto");
const db_1 = require("./db");
let cachedJwtSecret = null;
function getJwtSecret() {
    if (cachedJwtSecret) {
        return cachedJwtSecret;
    }
    const secret = process.env.MOBILE_JWT_SECRET;
    if (!secret) {
        throw new Error("MOBILE_JWT_SECRET environment variable is not set");
    }
    cachedJwtSecret = secret;
    return secret;
}
const GOOGLE_CLIENT_IDS = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
].filter(Boolean);
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "30d";
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
/**
 * Sign an access token (15 min expiry)
 */
function signAccessToken(userId, email) {
    const payload = {
        userId,
        email,
        type: "access",
    };
    return jsonwebtoken_1.default.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_EXPIRY });
}
/**
 * Sign a refresh token (30 day expiry)
 */
function signRefreshToken(userId, email) {
    const payload = {
        userId,
        email,
        type: "refresh",
    };
    return jsonwebtoken_1.default.sign(payload, getJwtSecret(), { expiresIn: REFRESH_TOKEN_EXPIRY });
}
/**
 * Verify and decode an access token
 */
function verifyAccessToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, getJwtSecret());
        if (decoded.type !== "access") {
            return null;
        }
        return decoded;
    }
    catch (_a) {
        return null;
    }
}
/**
 * Hash a token for secure storage
 */
function hashToken(token) {
    return (0, crypto_1.createHash)("sha256").update(token).digest("hex");
}
/**
 * Store a hashed refresh token in the database
 */
async function storeRefreshToken(userId, token, deviceInfo) {
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);
    await db_1.db.mobile_refresh_tokens.create({
        data: {
            user_id: userId,
            token_hash: tokenHash,
            device_info: deviceInfo,
            expires_at: expiresAt,
        },
    });
}
/**
 * Verify a refresh token against the database
 * Returns the decoded token if valid, null otherwise
 */
async function verifyRefreshToken(token) {
    try {
        // First verify the JWT signature and expiry
        const decoded = jsonwebtoken_1.default.verify(token, getJwtSecret());
        if (decoded.type !== "refresh") {
            return null;
        }
        // Check if token exists in DB and is not revoked
        const tokenHash = hashToken(token);
        const storedToken = await db_1.db.mobile_refresh_tokens.findUnique({
            where: { token_hash: tokenHash },
        });
        if (!storedToken) {
            return null;
        }
        // Check if token is revoked
        if (storedToken.revoked_at) {
            return null;
        }
        // Check if token is expired in DB
        if (storedToken.expires_at < new Date()) {
            return null;
        }
        return decoded;
    }
    catch (_a) {
        return null;
    }
}
/**
 * Revoke all refresh tokens for a user
 */
async function revokeUserRefreshTokens(userId) {
    await db_1.db.mobile_refresh_tokens.updateMany({
        where: {
            user_id: userId,
            revoked_at: null,
        },
        data: {
            revoked_at: new Date(),
        },
    });
}
/**
 * Revoke a specific refresh token
 */
async function revokeRefreshToken(token) {
    const tokenHash = hashToken(token);
    await db_1.db.mobile_refresh_tokens.updateMany({
        where: {
            token_hash: tokenHash,
            revoked_at: null,
        },
        data: {
            revoked_at: new Date(),
        },
    });
}
/**
 * Extract bearer token from Authorization header
 */
function extractBearerToken(authHeader) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }
    return authHeader.slice(7);
}
/**
 * Get authenticated user from request
 * Returns null if not authenticated
 */
async function getAuthenticatedUser(request) {
    const authHeader = request.headers.get("Authorization");
    const token = extractBearerToken(authHeader);
    if (!token) {
        return null;
    }
    const decoded = verifyAccessToken(token);
    if (!decoded) {
        return null;
    }
    return {
        userId: decoded.userId,
        email: decoded.email,
    };
}
/**
 * Clean up expired refresh tokens (can be called periodically)
 */
async function cleanupExpiredTokens() {
    const result = await db_1.db.mobile_refresh_tokens.deleteMany({
        where: {
            OR: [
                { expires_at: { lt: new Date() } },
                { revoked_at: { not: null } },
            ],
        },
    });
    return result.count;
}
/**
 * Verify a Google ID token using Google's tokeninfo endpoint
 * Returns the decoded payload if valid, null otherwise
 */
async function verifyGoogleIdToken(idToken) {
    try {
        // Verify the token with Google's tokeninfo endpoint
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!response.ok) {
            console.error("Google token verification failed:", response.status);
            return null;
        }
        const payload = (await response.json());
        // Verify the audience matches one of our client IDs
        if (GOOGLE_CLIENT_IDS.length > 0 && !GOOGLE_CLIENT_IDS.includes(payload.aud)) {
            console.error("Google token audience mismatch:", payload.aud);
            return null;
        }
        // Verify the issuer
        if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
            console.error("Google token issuer mismatch:", payload.iss);
            return null;
        }
        // Verify the token is not expired
        if (payload.exp * 1000 < Date.now()) {
            console.error("Google token expired");
            return null;
        }
        // Verify email is verified
        if (!payload.email_verified) {
            console.error("Google email not verified");
            return null;
        }
        return payload;
    }
    catch (error) {
        console.error("Error verifying Google ID token:", error);
        return null;
    }
}
/**
 * Find or create a user from Google OAuth
 * Returns the user ID and whether this is a new user
 */
async function findOrCreateGoogleUser(googlePayload) {
    // First, check if we have an existing OAuth account for this Google ID
    const existingOAuth = await db_1.db.user_oauth_accounts.findUnique({
        where: {
            provider_provider_id: {
                provider: "google",
                provider_id: googlePayload.sub,
            },
        },
        include: { user: true },
    });
    if (existingOAuth) {
        return {
            userId: existingOAuth.user_id,
            email: existingOAuth.user.email,
            isNewUser: false,
        };
    }
    // Check if a user exists with this email
    const existingUser = await db_1.db.user.findUnique({
        where: { email: googlePayload.email },
    });
    if (existingUser) {
        // Link the Google account to the existing user
        await db_1.db.user_oauth_accounts.create({
            data: {
                user_id: existingUser.id,
                provider: "google",
                provider_id: googlePayload.sub,
                email: googlePayload.email,
            },
        });
        return {
            userId: existingUser.id,
            email: existingUser.email,
            isNewUser: false,
        };
    }
    // Create a new user with the Google account
    const newUser = await db_1.db.user.create({
        data: {
            email: googlePayload.email,
            name: googlePayload.name || googlePayload.given_name || null,
            image: googlePayload.picture || null,
            emailVerified: new Date(), // Google email is verified
            profile: {
                create: {
                    name: googlePayload.name || googlePayload.given_name || null,
                    onboarded: false,
                },
            },
            oauth_accounts: {
                create: {
                    provider: "google",
                    provider_id: googlePayload.sub,
                    email: googlePayload.email,
                },
            },
        },
    });
    return {
        userId: newUser.id,
        email: newUser.email,
        isNewUser: true,
    };
}
