import { logger } from "./logger"
import { getMaxFileSize, validateContentType } from "./upload-rules"
import {
  CopyObjectCommand,
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

// The per-folder type and size rules, re-exported for existing callers.
export { getMaxFileSize, validateContentType }

/**
 * The folders the bucket policy makes world-readable.
 *
 * Everything the product shows to anyone — covers, avatars, sponsored
 * creatives — lives here and needs no signing. `chat` left the list with
 * SCRUM-427: a DM or room image is for the people in that chat, and it was
 * readable by anyone holding the URL, for ever. It is signed on the way out
 * (`readableUrl`). Note the staging bucket is public as a whole — the policy
 * below does not apply there — so the private bucket is what makes it private. `claims` is not in
 * the list on purpose: a venue claim's trade licence, FSSAI or liquor licence
 * names an address, a proprietor and often a GSTIN, and the only person who
 * should read it is the admin deciding the claim. It was uploaded under
 * `events/` and readable by anyone holding the URL (SCRUM-135). The policy is
 * re-applied on every boot by `ensureBucketExists`, so a folder missing from
 * this list is private by construction, not by remembering.
 */
export const PUBLIC_FOLDERS: readonly UploadFolder[] = ["profile", "events", "sponsored"]

/** Folders whose older objects may still sit in the public bucket, from before they moved. */
const MOVED_FROM_PUBLIC: readonly UploadFolder[] = ["chat"]

/** Where a folder's objects can be: its bucket, and for a folder that moved, the one it moved from. */
function bucketsHolding(folder: UploadFolder): string[] {
  return MOVED_FROM_PUBLIC.includes(folder) ? [bucketFor(folder), TIGRIS_BUCKET] : [bucketFor(folder)]
}

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
export function generateKey(folder: UploadFolder, filename: string, userId: string): string {
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

  /*
   * Valid for 15 minutes, and for the granted content type only (SCRUM-425).
   * The presigner leaves `content-type` out of the signature by default, so
   * the URL bound nothing but the host: an image grant stored an HTML page
   * that the public URL then served as text/html. Tigris refuses a PUT whose
   * type differs from a signed one (403, measured on staging). Every caller
   * already sends the type it asked for, so nothing honest changes.
   *
   * The size is still unbound here: signing `content-length` needs the client
   * to declare it first. What is attached is measured by `sealUpload`.
   */
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 900,
    signableHeaders: new Set(["content-type"]),
  })

  const publicUrl = getPublicUrl(key)

  return {
    uploadUrl,
    publicUrl,
    key,
  }
}

export type SealRefusal = "missing" | "too_small" | "too_large" | "wrong_type"
export type SealedObject = { key: string; url: string; bytes: number; contentType: string }

const SEAL_TIMEOUT_MS = 10_000

/**
 * Copy an upload to a key nobody holds an upload URL for, and vouch for the
 * copy (SCRUM-425). What a profile or a message stores is the copy.
 *
 * The URL `getPresignedUploadUrl` hands out can write its key again and again
 * until it expires, so a photo could be swapped after it was attached and
 * moderated. The copy's key is minted here and never signed for anyone, and
 * the source is deleted once the copy is vouched for, so nothing is left for
 * the URL to rewrite that anything points at.
 *
 * Checked twice. The source first, so an oversized or wrong file is refused
 * before a byte is copied. Then the copy, because the source can change
 * between the two and Tigris ignores `CopySourceIfMatch` (a copy with a
 * stale ETag still copied the new bytes, measured on staging). The copy's
 * headers are the server's (`REPLACE`), not whatever the uploader sent
 * alongside the one header the URL signs.
 *
 * Refusals are the person's to fix and come back as a value. A storage
 * failure is ours and throws, after removing any copy it left.
 *
 * `maxBytes` narrows the folder's ceiling for one kind of object: a blurred
 * photo is refused at a size that would make it the photo (SCRUM-476).
 */
export async function sealUpload(
  key: string,
  folder: "profile" | "chat",
  userId: string,
  minBytes = 1,
  maxBytes = getMaxFileSize(folder)
): Promise<SealedObject | { refused: SealRefusal }> {
  // Callers bind the key with `ownedObjectKey`; this is the backstop.
  if (!key.startsWith(`${folder}/${userId}/`)) throw new Error("sealUpload: key outside the caller's folder")
  const client = getS3Client()
  const Bucket = bucketFor(folder)
  const timeout = () => ({ abortSignal: AbortSignal.timeout(SEAL_TIMEOUT_MS) })
  const factsOf = async (Key: string) => {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket, Key }), timeout())
      return { bytes: head.ContentLength ?? 0, contentType: head.ContentType ?? "" }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
  const refusalOf = (facts: { bytes: number; contentType: string } | null): SealRefusal | null =>
    !facts ? "missing"
    : facts.bytes < minBytes ? "too_small"
    : facts.bytes > maxBytes ? "too_large"
    : !validateContentType(facts.contentType, folder) ? "wrong_type"
    : null
  const remove = (Key: string) =>
    client.send(new DeleteObjectCommand({ Bucket, Key })).catch((error: unknown) => {
      logger.warn("Seal: could not delete an object", { key: Key, error: error instanceof Error ? error.message : String(error) })
    })

  const source = await factsOf(key)
  const early = refusalOf(source)
  if (early || !source) return { refused: early ?? "missing" }

  const sealedKey = generateKey(folder, "sealed", userId)
  try {
    await client.send(
      new CopyObjectCommand({
        Bucket,
        Key: sealedKey,
        CopySource: `${Bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
        MetadataDirective: "REPLACE",
        ContentType: source.contentType,
        /*
         * `no-cache`, so an erasure takes at once. Tigris's public endpoint
         * serves a deleted object for as long as this allows: a year kept a
         * deleted account's photo up, and the default is an hour. With
         * `no-cache` it answered 404 straight after the delete, for a
         * revalidation per view at the edge, 12-24 ms warm (measured on
         * staging, SCRUM-445). The app keeps its own image cache.
         */
        CacheControl: "no-cache",
        Metadata: { "uploaded-by": userId },
      }),
      timeout()
    )
    const copy = await factsOf(sealedKey)
    const refused = refusalOf(copy)
    if (refused || !copy) {
      await remove(sealedKey)
      return { refused: refused ?? "missing" }
    }
    await remove(key)
    return { key: sealedKey, url: getPublicUrl(sealedKey), bytes: copy.bytes, contentType: copy.contentType }
  } catch (error) {
    // An aborted call does not cancel a copy the storage already started.
    await remove(sealedKey)
    if (isNotFound(error)) return { refused: "missing" }
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404
}

/**
 * Delete a file from Tigris
 */
export async function deleteFile(key: string): Promise<void> {
  const client = getS3Client()
  for (const Bucket of bucketsHolding(key.split("/")[0] as UploadFolder)) {
    await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
  }
}

/**
 * Delete every object under a prefix, except the keys in `keep`. Returns how many went.
 *
 * Account deletion nulled `profiles.photos` and left the objects in a
 * public-read bucket under deterministic keys, so any URL another person had
 * seen kept resolving to the deleted person's face for ever. `keep` is removed
 * content, retained for its period (SCRUM-428).
 */
export async function deletePrefix(prefix: string, keep: ReadonlySet<string> = new Set()): Promise<number> {
  let deleted = 0
  for (const bucket of bucketsHolding(prefix.split("/")[0] as UploadFolder)) {
    deleted += await deletePrefixIn(bucket, prefix, keep)
  }
  return deleted
}

/** Per storage call, so a hung request cannot stall the retention sweep behind it (SCRUM-429). */
const DELETE_CALL_TIMEOUT_MS = 30_000

async function deletePrefixIn(bucket: string, prefix: string, keep: ReadonlySet<string>): Promise<number> {
  const client = getS3Client()
  const deleteDeadline = () => ({ abortSignal: AbortSignal.timeout(DELETE_CALL_TIMEOUT_MS) })
  let deleted = 0
  let refused = 0
  let token: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      deleteDeadline()
    )
    const keys = (page.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => Boolean(k) && !keep.has(k as string))
    if (keys.length > 0) {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
        deleteDeadline()
      )
      // Quiet mode reports only failures: count what actually went, and say which did not.
      const failed = result?.Errors ?? []
      if (failed.length > 0) logger.error("deletePrefix: objects not deleted", { prefix, bucket, keys: failed.map((e) => e.Key) })
      deleted += keys.length - failed.length
      refused += failed.length
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  /*
   * After every page, so it deletes all it can: then an erasure that left
   * something behind says so. It returned a count, and the retention sweep read
   * a partial erasure as done and dropped the only pointer to what was left.
   */
  if (refused > 0) throw new Error(`deletePrefix: ${refused} object(s) under ${prefix} not deleted`)
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
  // Chat media is referenced on the private bucket's host (SCRUM-427). The
  // folder, not the host, still decides which bucket an object is read from.
  `${TIGRIS_PRIVATE_BUCKET}.fly.storage.tigris.dev`,
  `${TIGRIS_PRIVATE_BUCKET}.t3.storage.dev`,
])

const PRIVATE_HOSTS = new Set([`${TIGRIS_PRIVATE_BUCKET}.fly.storage.tigris.dev`, `${TIGRIS_PRIVATE_BUCKET}.t3.storage.dev`])

/**
 * A stored media reference as a reader may fetch it: signed for 15 minutes if
 * it is on the private bucket, unchanged otherwise (SCRUM-427).
 *
 * Never throws. It runs on every response (`resolveMediaFields`), so a signing
 * failure returns the bare reference, which the private bucket answers 403 —
 * closed, not open.
 */
export async function readableUrl(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!PRIVATE_HOSTS.has(parsed.hostname)) return url
  try {
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
    // Chat media only. The same bucket holds venue-claim documents, and a
    // stored reference is not proof the reader may have them.
    if (!key.startsWith("chat/") || key.split("/").includes("..")) return url
    return await getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: TIGRIS_PRIVATE_BUCKET, Key: key }), {
      expiresIn: 900,
    })
  } catch (error) {
    logger.warn("Could not sign a private media URL", { error: error instanceof Error ? error.message : String(error) })
    return url
  }
}

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
  /*
   * The URL we would have written (SCRUM-426). Callers store the string as
   * sent, so the string validated has to be the one later fetched: no
   * credentials or port, and nothing the parser had to normalise
   * (`host/x/../chat/<me>/f`, an upper-case host, a backslash). A query or
   * fragment still fetches the same object from our bucket, and #204 lets a
   * photo URL carry one, so those are tolerated.
   */
  if (parsed.username || parsed.password || parsed.port) return null
  if (`${parsed.origin}${parsed.pathname}` !== url.split(/[?#]/)[0]) return null
  // Exact hostname match, never a substring or a suffix: `notblendn-media...`
  // and `...tigris.dev.evil.example` both fail here and would both pass a
  // `includes()` or `endsWith()` check.
  if (!ALLOWED_PHOTO_HOSTS.has(parsed.hostname)) return null

  // A malformed escape ("%" with nothing after it) is not ours either, and must
  // not throw: every caller turns null into a 400, and a throw into a 500.
  let key: string
  try {
    key = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
  } catch {
    return null
  }

  // `..` cannot escape an S3 key the way it escapes a filesystem path, but the
  // key is used to build further requests, and a traversal-looking key is never
  // something we generated.
  // A `..` segment, not any two dots: "a..b.jpg" is a file its owner may attach.
  if (key.split("/").includes("..")) return null

  // The folder AND the owner. `profile/<userId>/` is the only shape this
  // accepts, so somebody else's photo -- or a chat attachment, which is a
  // different trust class -- is refused.
  const prefix = `${folder}/${userId}/`
  if (!key.startsWith(prefix) || key.length <= prefix.length) return null

  return key
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
