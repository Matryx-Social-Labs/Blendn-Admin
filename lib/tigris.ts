import { SPONSORSHIP } from "./constants"
import { logger } from "./logger"
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
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
/**
 * Where private documents live. Tigris makes access a property of the
 * BUCKET: a public bucket serves every object to anyone, `PutBucketPolicy`
 * is not implemented and a per-object `private` ACL is accepted and ignored
 * (both verified against staging while fixing SCRUM-135). So a private
 * folder inside the public bucket cannot exist; a second bucket, private by
 * default, is the only lever. Created on boot if missing, never given a
 * public policy, read only through signed URLs.
 */
const TIGRIS_PRIVATE_BUCKET = process.env.TIGRIS_PRIVATE_BUCKET || `${TIGRIS_BUCKET}-private`
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
export type UploadFolder = "profile" | "chat" | "events" | "sponsored" | "claims"

/**
 * The folders the bucket policy makes world-readable.
 *
 * Everything the product shows to anyone — covers, avatars, chat media,
 * sponsored creatives — lives here and needs no signing. `claims` is not in
 * the list on purpose: a venue claim's trade licence, FSSAI or liquor licence
 * names an address, a proprietor and often a GSTIN, and the only person who
 * should read it is the admin deciding the claim. It was uploaded under
 * `events/` and readable by anyone holding the URL (SCRUM-135). The policy is
 * re-applied on every boot by `ensureBucketExists`, so a folder missing from
 * this list is private by construction, not by remembering.
 */
export const PUBLIC_FOLDERS: readonly UploadFolder[] = ["profile", "chat", "events", "sponsored"]

/** The bucket a folder lives in: the public one, or the private one. */
export function bucketFor(folder: UploadFolder): string {
  return (PUBLIC_FOLDERS as readonly string[]).includes(folder) ? TIGRIS_BUCKET : TIGRIS_PRIVATE_BUCKET
}

function bucketForKey(key: string): string {
  return bucketFor(key.split("/")[0] as UploadFolder)
}

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
  // Tigris uses virtual-hosted style URLs for public access. For a private
  // key this is the stored reference, not something that serves.
  return `https://${bucketForKey(key)}.fly.storage.tigris.dev/${key}`
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
    Bucket: bucketFor(folder),
    Key: key,
    ContentType: contentType,
    ...(opts.checksum ? { ChecksumAlgorithm: "SHA256" as const } : {}),
    // Set cache control for browser caching. A private document is never
    // cached by an intermediary.
    CacheControl: PUBLIC_FOLDERS.includes(folder) ? "public, max-age=31536000" : "private, no-store",
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
    Bucket: bucketForKey(key),
    Key: key,
  })

  await client.send(command)
}

/**
 * Delete every object under a prefix. Returns how many went.
 *
 * Account deletion nulled `profiles.photos` and left the objects in a
 * public-read bucket under deterministic keys, so any URL another person had
 * seen -- a match card, a chat, a screenshot -- kept resolving to the
 * deleted person's face for ever. The prefix is `profile/{userId}/`; the
 * caller passes it, this only lists and deletes.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  const client = getS3Client()
  let deleted = 0
  let token: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucketForKey(prefix), Prefix: prefix, ContinuationToken: token })
    )
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k))
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketForKey(prefix),
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        })
      )
      deleted += keys.length
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return deleted
}

/**
 * Extract the key from a public URL
 */
export function extractKeyFromUrl(url: string): string | null {
  const cleanedUrl = url.split(/[?#]/)[0]

  for (const bucket of [TIGRIS_BUCKET, TIGRIS_PRIVATE_BUCKET]) {
    // Virtual-hosted (fly and t3 hosts), then legacy path-style.
    for (const prefix of [
      `${bucket}.fly.storage.tigris.dev/`,
      `${bucket}.t3.storage.dev/`,
      `/${bucket}/`,
    ]) {
      const index = cleanedUrl.indexOf(prefix)
      if (index !== -1) return cleanedUrl.substring(index + prefix.length)
    }
  }
  return null
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
  return ownedObjectKey(url, userId, "profile")
}

/**
 * The same binding for any folder the person may own an object in. `folder`
 * is an allow-list value, never something read out of the URL: the delete
 * route used to accept whatever `extractKeyFromUrl` produced -- the function
 * whose own docstring calls it "useless as a security check" -- and matched
 * only `pathParts[1]` against the caller.
 */
export function ownedObjectKey(url: string, userId: string, folder: UploadFolder): string | null {
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
  const prefix = `${folder}/${userId}/`
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
    // The SDK has no default request timeout; this HEAD is on the profile
    // PUT's path, and "the object is not there" must not take a minute.
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucketForKey(key), Key: key }),
      { abortSignal: AbortSignal.timeout(5_000) }
    )
    return head.ContentLength ?? null
  } catch {
    return null
  }
}

/**
 * A URL that can read a private object for the next `expiresIn` seconds.
 *
 * For anything outside `PUBLIC_FOLDERS`. The reviewer's queue is the one
 * consumer: it renders each claim's documents through this, so the link in
 * the page works for the sitting and the stored URL works for nobody.
 */
export async function getPresignedReadUrl(key: string, expiresIn = 900): Promise<string> {
  const client = getS3Client()
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucketForKey(key), Key: key }), { expiresIn })
}

/**
 * The URL to show a reviewer for a stored evidence reference.
 *
 * A key under a private folder is signed; anything else — a public-folder
 * object, or a link the claimant pasted — is returned unchanged. Evidence
 * filed before `claims/` existed sits under `events/` and stays readable
 * through this exactly as it did.
 */
export async function reviewableUrl(urlOrKey: string): Promise<string> {
  const key = extractKeyFromUrl(urlOrKey)
  if (!key) return urlOrKey
  const folder = key.split("/")[0] as UploadFolder
  if ((PUBLIC_FOLDERS as readonly string[]).includes(folder)) return urlOrKey
  return getPresignedReadUrl(key)
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
    /*
     * `video/mp4` because an event gallery has always been able to hold a clip
     * and could never receive one.
     *
     * The Gallery offers Type = Video, its file input accepts `video/mp4`, the
     * help text specifies the encode down to faststart, `media-section.tsx`
     * says "video has always been supported here", the seed attaches clips to
     * two events, and the app's feed card cycles them. The only thing that said
     * otherwise was this list, which had no comment — the one below it is about
     * `sponsored`. So every organiser upload 400'd at the presigned-url step
     * and the clip could only ever arrive by pasting a URL.
     *
     * The 20MB ceiling in `getMaxFileSize` was already sized for video; images
     * are capped at 8MB by the form's own copy.
     */
    events: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
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
    // A scan or a photo of a licence; nothing that plays.
    claims: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
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
    claims: 20 * 1024 * 1024, // 20MB
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

/** The bucket policy: anonymous read on the public folders and nothing else. */
function publicReadPolicy(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicRead",
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: PUBLIC_FOLDERS.map((folder) => `arn:aws:s3:::${bucket}/${folder}/*`),
      },
    ],
  }
}

async function setBucketPublicRead(): Promise<void> {
  const client = getS3Client()
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: TIGRIS_BUCKET,
      Policy: JSON.stringify(publicReadPolicy(TIGRIS_BUCKET)),
    })
  )
  logger.info("Public-read policy set for bucket", { bucket: TIGRIS_BUCKET })
}

const BROWSER_UPLOAD_CORS = {
  CORSRules: [
    {
      AllowedHeaders: ["*"],
      AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
      AllowedOrigins: ["*"],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    },
  ],
}

/**
 * The private bucket: created if missing, with the CORS the browser's
 * direct PUT needs, and deliberately never a public policy. A failure here
 * is logged and does not stop the boot — the media bucket is what the
 * product cannot run without; a missing private bucket fails only the next
 * claim upload, loudly.
 */
async function ensurePrivateBucket(client: S3Client): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: TIGRIS_PRIVATE_BUCKET }))
    return
  } catch (error: unknown) {
    const s3Error = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (s3Error.name !== "NotFound" && s3Error.$metadata?.httpStatusCode !== 404) {
      logger.warn("Could not check the private bucket", {
        bucket: TIGRIS_PRIVATE_BUCKET,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: TIGRIS_PRIVATE_BUCKET }))
    await client.send(
      new PutBucketCorsCommand({ Bucket: TIGRIS_PRIVATE_BUCKET, CORSConfiguration: BROWSER_UPLOAD_CORS })
    )
    logger.info("Private bucket created", { bucket: TIGRIS_PRIVATE_BUCKET })
  } catch (error) {
    logger.error("Failed to create the private bucket", {
      bucket: TIGRIS_PRIVATE_BUCKET,
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
    await ensurePrivateBucket(client)
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
        await ensurePrivateBucket(client)
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
