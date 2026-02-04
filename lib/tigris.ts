import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

// Tigris Configuration (S3-compatible on Railway)
const TIGRIS_ENDPOINT = process.env.TIGRIS_ENDPOINT || ""
const TIGRIS_ACCESS_KEY = process.env.TIGRIS_ACCESS_KEY || ""
const TIGRIS_SECRET_KEY = process.env.TIGRIS_SECRET_KEY || ""
const TIGRIS_BUCKET = process.env.TIGRIS_BUCKET || "blendn-media"
const TIGRIS_REGION = process.env.TIGRIS_REGION || "auto"

// Validate configuration
function validateConfig(): boolean {
  if (!TIGRIS_ENDPOINT || !TIGRIS_ACCESS_KEY || !TIGRIS_SECRET_KEY) {
    console.warn("Tigris configuration incomplete. Storage features will be disabled.")
    return false
  }
  return true
}

// Create S3 client configured for Tigris
let s3Client: S3Client | null = null

function getS3Client(): S3Client {
  if (!s3Client) {
    if (!validateConfig()) {
      throw new Error("Tigris not configured")
    }

    s3Client = new S3Client({
      endpoint: TIGRIS_ENDPOINT,
      region: TIGRIS_REGION,
      credentials: {
        accessKeyId: TIGRIS_ACCESS_KEY,
        secretAccessKey: TIGRIS_SECRET_KEY,
      },
      forcePathStyle: true, // Required for S3-compatible services
    })
  }

  return s3Client
}

// Folder types for organizing uploads
export type UploadFolder = "profile" | "chat" | "events"

/**
 * Generate a unique filename with folder prefix
 */
function generateKey(folder: UploadFolder, filename: string, userId: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  const sanitizedName = filename
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .substring(0, 50)

  return `${folder}/${userId}/${timestamp}-${random}-${sanitizedName}`
}

/**
 * Get the public URL for a stored object
 */
function getPublicUrl(key: string): string {
  // Tigris provides public URLs via the endpoint
  // Remove trailing slash from endpoint if present
  const endpoint = TIGRIS_ENDPOINT.replace(/\/$/, "")
  return `${endpoint}/${TIGRIS_BUCKET}/${key}`
}

/**
 * Generate a presigned URL for uploading a file directly to Tigris
 * The URL is valid for 15 minutes
 */
export async function getPresignedUploadUrl(
  filename: string,
  contentType: string,
  folder: UploadFolder,
  userId: string
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const client = getS3Client()
  const key = generateKey(folder, filename, userId)

  const command = new PutObjectCommand({
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
  })

  // Generate presigned URL valid for 15 minutes
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 900, // 15 minutes
  })

  const publicUrl = getPublicUrl(key)

  return {
    uploadUrl,
    publicUrl,
    key,
  }
}

/**
 * Delete a file from Tigris
 */
export async function deleteFile(key: string): Promise<void> {
  const client = getS3Client()

  const command = new DeleteObjectCommand({
    Bucket: TIGRIS_BUCKET,
    Key: key,
  })

  await client.send(command)
}

/**
 * Extract the key from a public URL
 */
export function extractKeyFromUrl(url: string): string | null {
  const bucketPrefix = `/${TIGRIS_BUCKET}/`
  const index = url.indexOf(bucketPrefix)
  if (index === -1) return null
  return url.substring(index + bucketPrefix.length)
}

/**
 * Validate content type for uploads
 */
export function validateContentType(contentType: string, folder: UploadFolder): boolean {
  const allowedTypes: Record<UploadFolder, string[]> = {
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
  }

  return allowedTypes[folder]?.includes(contentType) ?? false
}

/**
 * Get maximum file size for a folder (in bytes)
 */
export function getMaxFileSize(folder: UploadFolder): number {
  const maxSizes: Record<UploadFolder, number> = {
    profile: 10 * 1024 * 1024, // 10MB
    chat: 50 * 1024 * 1024, // 50MB
    events: 20 * 1024 * 1024, // 20MB
  }

  return maxSizes[folder] ?? 10 * 1024 * 1024
}

/**
 * Check if Tigris is configured
 */
export function isConfigured(): boolean {
  return validateConfig()
}

/**
 * Ensure the bucket exists, create it if not
 */
export async function ensureBucketExists(): Promise<boolean> {
  if (!validateConfig()) {
    console.warn("Tigris not configured, skipping bucket check")
    return false
  }

  const client = getS3Client()

  try {
    // Check if bucket exists
    await client.send(new HeadBucketCommand({ Bucket: TIGRIS_BUCKET }))
    console.log(`✅ Bucket "${TIGRIS_BUCKET}" exists`)
    return true
  } catch (error: unknown) {
    const s3Error = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (s3Error.name === "NotFound" || s3Error.$metadata?.httpStatusCode === 404) {
      // Bucket doesn't exist, create it
      console.log(`Creating bucket "${TIGRIS_BUCKET}"...`)
      try {
        await client.send(new CreateBucketCommand({ Bucket: TIGRIS_BUCKET }))
        console.log(`✅ Bucket "${TIGRIS_BUCKET}" created`)

        // Set up CORS for the bucket
        await client.send(
          new PutBucketCorsCommand({
            Bucket: TIGRIS_BUCKET,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedHeaders: ["*"],
                  AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                  AllowedOrigins: ["*"],
                  ExposeHeaders: ["ETag"],
                  MaxAgeSeconds: 3600,
                },
              ],
            },
          })
        )
        console.log(`✅ CORS configured for bucket "${TIGRIS_BUCKET}"`)
        return true
      } catch (createError) {
        console.error(`❌ Failed to create bucket:`, createError)
        return false
      }
    }
    console.error(`❌ Error checking bucket:`, error)
    return false
  }
}

/**
 * Test the Tigris connection
 */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  if (!validateConfig()) {
    return { success: false, message: "Tigris not configured" }
  }

  try {
    const bucketExists = await ensureBucketExists()
    if (bucketExists) {
      return { success: true, message: `Connected to Tigris. Bucket: ${TIGRIS_BUCKET}` }
    }
    return { success: false, message: "Failed to verify/create bucket" }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Connection failed"
    return { success: false, message }
  }
}
