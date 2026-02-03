"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPresignedUploadUrl = getPresignedUploadUrl;
exports.deleteFile = deleteFile;
exports.extractKeyFromUrl = extractKeyFromUrl;
exports.validateContentType = validateContentType;
exports.getMaxFileSize = getMaxFileSize;
exports.isConfigured = isConfigured;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
// Tigris Configuration (S3-compatible on Railway)
const TIGRIS_ENDPOINT = process.env.TIGRIS_ENDPOINT || "";
const TIGRIS_ACCESS_KEY = process.env.TIGRIS_ACCESS_KEY || "";
const TIGRIS_SECRET_KEY = process.env.TIGRIS_SECRET_KEY || "";
const TIGRIS_BUCKET = process.env.TIGRIS_BUCKET || "blendn-media";
const TIGRIS_REGION = process.env.TIGRIS_REGION || "auto";
// Validate configuration
function validateConfig() {
    if (!TIGRIS_ENDPOINT || !TIGRIS_ACCESS_KEY || !TIGRIS_SECRET_KEY) {
        console.warn("Tigris configuration incomplete. Storage features will be disabled.");
        return false;
    }
    return true;
}
// Create S3 client configured for Tigris
let s3Client = null;
function getS3Client() {
    if (!s3Client) {
        if (!validateConfig()) {
            throw new Error("Tigris not configured");
        }
        s3Client = new client_s3_1.S3Client({
            endpoint: TIGRIS_ENDPOINT,
            region: TIGRIS_REGION,
            credentials: {
                accessKeyId: TIGRIS_ACCESS_KEY,
                secretAccessKey: TIGRIS_SECRET_KEY,
            },
            forcePathStyle: true, // Required for S3-compatible services
        });
    }
    return s3Client;
}
/**
 * Generate a unique filename with folder prefix
 */
function generateKey(folder, filename, userId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const sanitizedName = filename
        .replace(/[^a-zA-Z0-9.-]/g, "_")
        .substring(0, 50);
    return `${folder}/${userId}/${timestamp}-${random}-${sanitizedName}`;
}
/**
 * Get the public URL for a stored object
 */
function getPublicUrl(key) {
    // Tigris provides public URLs via the endpoint
    // Remove trailing slash from endpoint if present
    const endpoint = TIGRIS_ENDPOINT.replace(/\/$/, "");
    return `${endpoint}/${TIGRIS_BUCKET}/${key}`;
}
/**
 * Generate a presigned URL for uploading a file directly to Tigris
 * The URL is valid for 15 minutes
 */
async function getPresignedUploadUrl(filename, contentType, folder, userId) {
    const client = getS3Client();
    const key = generateKey(folder, filename, userId);
    const command = new client_s3_1.PutObjectCommand({
        Bucket: TIGRIS_BUCKET,
        Key: key,
        ContentType: contentType,
        // Set cache control for browser caching
        CacheControl: "public, max-age=31536000",
        // Set metadata
        Metadata: {
            "uploaded-by": userId,
            "original-filename": filename,
        },
    });
    // Generate presigned URL valid for 15 minutes
    const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(client, command, {
        expiresIn: 900, // 15 minutes
    });
    const publicUrl = getPublicUrl(key);
    return {
        uploadUrl,
        publicUrl,
        key,
    };
}
/**
 * Delete a file from Tigris
 */
async function deleteFile(key) {
    const client = getS3Client();
    const command = new client_s3_1.DeleteObjectCommand({
        Bucket: TIGRIS_BUCKET,
        Key: key,
    });
    await client.send(command);
}
/**
 * Extract the key from a public URL
 */
function extractKeyFromUrl(url) {
    const bucketPrefix = `/${TIGRIS_BUCKET}/`;
    const index = url.indexOf(bucketPrefix);
    if (index === -1)
        return null;
    return url.substring(index + bucketPrefix.length);
}
/**
 * Validate content type for uploads
 */
function validateContentType(contentType, folder) {
    var _a, _b;
    const allowedTypes = {
        profile: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        chat: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/quicktime",
            "audio/mpeg",
            "audio/mp4",
        ],
        events: ["image/jpeg", "image/png", "image/webp"],
    };
    return (_b = (_a = allowedTypes[folder]) === null || _a === void 0 ? void 0 : _a.includes(contentType)) !== null && _b !== void 0 ? _b : false;
}
/**
 * Get maximum file size for a folder (in bytes)
 */
function getMaxFileSize(folder) {
    var _a;
    const maxSizes = {
        profile: 10 * 1024 * 1024, // 10MB
        chat: 50 * 1024 * 1024, // 50MB
        events: 20 * 1024 * 1024, // 20MB
    };
    return (_a = maxSizes[folder]) !== null && _a !== void 0 ? _a : 10 * 1024 * 1024;
}
/**
 * Check if Tigris is configured
 */
function isConfigured() {
    return validateConfig();
}
