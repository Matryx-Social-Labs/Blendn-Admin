import { SPONSORSHIP } from "./constants"
import { logger } from "./logger"
import {
  HeadObjectCommand,
  S3Client,
  PutObjectCommand,
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
export type UploadFolder = "profile" | "chat" | "events" | "sponsored"

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
  userId: string,
  opts: {
    /**
     * Ask the storage to compute and store a SHA-256.
     *
     * Signed into the URL, so a client that ignores it gets a rejected PUT
     * rather than a silently unverifiable object. Only worth the round trip
     * where provenance matters — sponsored media, which is reviewed once and
     * then sent unattended for hours.
     */
    checksum?: boolean
  } = {}
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const client = getS3Client()
  const key = generateKey(folder, filename, userId)

  const command = new PutObjectCommand({
    Bucket: TIGRIS_BUCKET,
    Key: key,
    ContentType: contentType,
    ...(opts.checksum ? { ChecksumAlgorithm: "SHA256" as const } : {}),
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
 * Is this URL a photo in our bucket, belonging to this user?
 *
 * ## Why `extractKeyFromUrl` is not enough
 *
 * That function finds the bucket prefix with `indexOf`, anywhere in the string.
 * Fine for the cleanup it was written for; useless as a security check, because
 * `https://evil.example/?x=blendn-media.fly.storage.tigris.dev/a` matches it.
 *
 * ## Why this exists at all
 *
 * `photos` is validated as `z.string().url()` and nothing more, and the client
 * uploads straight to Tigris and then POSTs the resulting URL back. The moment
 * the server *fetches* those URLs -- to moderate them, to size them, to make a
 * thumbnail -- that field becomes an SSRF primitive: `http://169.254.169.254/`,
 * an internal host, a five-gigabyte file. Every one of those is a URL.
 *
 * So nothing fetches a photo URL that has not been through here first.
 *
 * The key format is `profile/<userId>/<timestamp>-<random>-<name>` (see
 * `generateKey`), which means ownership is provable from the URL alone: no
 * database round trip, and no way to point at somebody else's object.
 */
const ALLOWED_PHOTO_HOSTS = new Set([
  `${TIGRIS_BUCKET}.fly.storage.tigris.dev`,
  `${TIGRIS_BUCKET}.t3.storage.dev`,
])

export function ownedPhotoKey(url: string, userId: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  // https only. An http URL to our own bucket is still a downgrade we would be
  // performing on the user's behalf.
  if (parsed.protocol !== "https:") return null
  // Exact hostname match, never a substring or a suffix: `notblendn-media...`
  // and `...tigris.dev.evil.example` both fail here and would both pass a
  // `includes()` or `endsWith()` check.
  if (!ALLOWED_PHOTO_HOSTS.has(parsed.hostname)) return null

  const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""))

  // `..` cannot escape an S3 key the way it escapes a filesystem path, but the
  // key is used to build further requests, and a traversal-looking key is never
  // something we generated.
  if (key.includes("..")) return null

  // The folder AND the owner. `profile/<userId>/` is the only shape this
  // accepts, so somebody else's photo -- or a chat attachment, which is a
  // different trust class -- is refused.
  const prefix = `profile/${userId}/`
  if (!key.startsWith(prefix) || key.length <= prefix.length) return null

  return key
}

/**
 * How large is this object, in bytes? `null` if it is not there.
 *
 * A metadata call, not a download: it never pulls the image, so it costs one
 * round trip and no memory regardless of file size.
 *
 * This is also the whole blank-image check. A solid colour, a lens cap or a
 * photo of a wall compresses to a few kilobytes where a real photograph is
 * hundreds -- so a size floor catches the class without decoding anything.
 * The alternative was `sharp` for per-channel standard deviation, which means
 * a native dependency in the Railway image and a full download per photo, to
 * separate "blank" from "nearly blank" more precisely than anyone needs.
 */
export async function getObjectSize(key: string): Promise<number | null> {
  const client = getS3Client()
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: TIGRIS_BUCKET, Key: key })
    )
    return head.ContentLength ?? null
  } catch {
    return null
  }
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
    /*
     * Deliberately narrower than `chat`, which allows GIF, QuickTime and audio.
     *
     * An animated GIF in a room is a loop nobody can stop. QuickTime does not
     * play inline on Android. Audio has no poster frame, so it cannot be
     * rendered as anything a person can decline to open. Sponsored media is the
     * one kind an attendee did not choose to receive, so the format has to be
     * one every phone plays inline, muted, on demand.
     */
    sponsored: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
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
    // The ceiling for the folder. `lib/upload-grant-actions.ts` narrows it
    // further per content type — an image has no business being 100MB.
    sponsored: SPONSORSHIP.MAX_VIDEO_BYTES,
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

export interface ObjectFacts {
  bytes: number
  contentType: string | null
  /**
   * The object version, when the bucket has versioning on.
   *
   * This is what actually pins the bytes. A content-addressed KEY is impossible
   * with a presigned PUT — the key is chosen before the bytes exist — so the
   * only defence against the same key being overwritten after review is to pin
   * the version that was reviewed and serve that one.
   */
  versionId: string | null
  /**
   * SHA-256, only when the storage computed one.
   *
   * Requested via `ChecksumAlgorithm` on the presigned PUT, which the client has
   * to honour. Recorded when present and never fabricated: a checksum we made up
   * from an ETag would look like provenance and be an MD5 for single-part
   * uploads and a hash-of-hashes for multipart, which is not a content identity
   * at all.
   */
  checksumSha256: string | null
}

/** Everything about a stored object that a grant needs to pin. One HEAD. */
export async function headObject(key: string): Promise<ObjectFacts | null> {
  const client = getS3Client()
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: TIGRIS_BUCKET, Key: key, ChecksumMode: "ENABLED" })
    )
    return {
      bytes: head.ContentLength ?? 0,
      contentType: head.ContentType ?? null,
      versionId: head.VersionId ?? null,
      checksumSha256: head.ChecksumSHA256 ?? null,
    }
  } catch {
    // Missing, or a permissions problem. Both mean "cannot vouch for this".
    return null
  }
}

/** The public URL for a key, pinned to a version when there is one. */
export function pinnedUrl(key: string, versionId: string | null): string {
  const base = getPublicUrl(key)
  return versionId ? `${base}?versionId=${encodeURIComponent(versionId)}` : base
}
