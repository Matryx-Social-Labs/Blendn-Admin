import { logger } from "./logger"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
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
    logger.warn("Tigris configuration incomplete. Storage features will be disabled.")
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
  // Tigris uses virtual-hosted style URLs for public access
  return `https://${TIGRIS_BUCKET}.fly.storage.tigris.dev/${key}`
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
  const cleanedUrl = url.split(/[?#]/)[0]

  // Handle virtual-hosted style: https://bucket.fly.storage.tigris.dev/key
  const vhostPrefix = `${TIGRIS_BUCKET}.fly.storage.tigris.dev/`
  const vhostIndex = cleanedUrl.indexOf(vhostPrefix)
  if (vhostIndex !== -1) {
    return cleanedUrl.substring(vhostIndex + vhostPrefix.length)
  }

  // Handle virtual-hosted t3 style: https://bucket.t3.storage.dev/key
  const t3VhostPrefix = `${TIGRIS_BUCKET}.t3.storage.dev/`
  const t3VhostIndex = cleanedUrl.indexOf(t3VhostPrefix)
  if (t3VhostIndex !== -1) {
    return cleanedUrl.substring(t3VhostIndex + t3VhostPrefix.length)
  }

  // Handle legacy path-style: https://t3.storage.dev/bucket/key
  const bucketPrefix = `/${TIGRIS_BUCKET}/`
  const index = cleanedUrl.indexOf(bucketPrefix)
  if (index === -1) return null
  return cleanedUrl.substring(index + bucketPrefix.length)
}

/**
 * Generate a presigned download URL for a stored object
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresIn: number = 604800
): Promise<string> {
  const client = getS3Client()
  const command = new GetObjectCommand({
    Bucket: TIGRIS_BUCKET,
    Key: key,
  })

  return getSignedUrl(client, command, { expiresIn })
}

/**
 * Resolve a media URL/key to a publicly-accessible URL.
 * The bucket has a public-read policy so no signing is needed.
 * Non-Tigris URLs are returned unchanged.
 */
export function getAccessibleMediaUrl(urlOrKey: string): string {
  if (!urlOrKey) return urlOrKey

  const key =
    extractKeyFromUrl(urlOrKey) ||
    (!urlOrKey.startsWith("http://") && !urlOrKey.startsWith("https://")
      ? urlOrKey.replace(/^\/+/, "")
      : null)

  if (!key) {
    return urlOrKey
  }

  return getPublicUrl(key)
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
 * Set bucket policy to allow public read access.
 * This lets profile/event/chat images be served without presigned URLs.
 */
/**
 * Applying the public-read policy is best-effort and must never decide whether
 * storage is usable.
 *
 * Tigris does not implement S3 bucket policies the way AWS does — PutBucketPolicy
 * comes back with "A header you provided implies functionality that is not
 * implemented". Previously that rejection propagated to the caller's catch, which
 * logged the misleading "Error checking bucket" and returned false for a bucket
 * that exists and works. Public read access on Tigris is a bucket setting, not
 * something to reassert on every boot.
 */
async function trySetBucketPublicRead(): Promise<void> {
  try {
    await setBucketPublicRead()
  } catch (error) {
    logger.warn("Could not apply public-read bucket policy (set it on the bucket itself)", {
      bucket: TIGRIS_BUCKET,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function setBucketPublicRead(): Promise<void> {
  const client = getS3Client()
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicRead",
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${TIGRIS_BUCKET}/*`],
      },
    ],
  })

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: TIGRIS_BUCKET,
      Policy: policy,
    })
  )
  logger.info("Public-read policy set for bucket", { bucket: TIGRIS_BUCKET })
}

/**
 * Ensure the bucket exists, create it if not
 */
export async function ensureBucketExists(): Promise<boolean> {
  if (!validateConfig()) {
    logger.warn("Tigris not configured, skipping bucket check")
    return false
  }

  const client = getS3Client()

  try {
    // Check if bucket exists
    await client.send(new HeadBucketCommand({ Bucket: TIGRIS_BUCKET }))
    logger.info("Bucket exists", { bucket: TIGRIS_BUCKET })
    await trySetBucketPublicRead()
    return true
  } catch (error: unknown) {
    const s3Error = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (s3Error.name === "NotFound" || s3Error.$metadata?.httpStatusCode === 404) {
      // Bucket doesn't exist, create it
      logger.info("Creating bucket", { bucket: TIGRIS_BUCKET })
      try {
        await client.send(new CreateBucketCommand({ Bucket: TIGRIS_BUCKET }))
        logger.info("Bucket created", { bucket: TIGRIS_BUCKET })

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
        logger.info("CORS configured for bucket", { bucket: TIGRIS_BUCKET })
        await trySetBucketPublicRead()
        return true
      } catch (createError) {
        logger.error("Failed to create bucket", { bucket: TIGRIS_BUCKET, error: createError instanceof Error ? createError.message : String(createError) })
        return false
      }
    }
    logger.error("Error checking bucket", { bucket: TIGRIS_BUCKET, error: error instanceof Error ? error.message : String(error) })
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
