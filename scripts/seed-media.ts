import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"

/**
 * Where seeded media comes from — split out of seed-qa.ts so it can be tested
 * without running the seed.
 */

/**
 * The bucket seeded media lives in. The seed only ever runs against staging or
 * a local database (`environmentRefusal`), and staging's bucket is public-read,
 * so without `TIGRIS_BUCKET` it is still the right place to look.
 */
export const SEED_BUCKET = process.env.TIGRIS_BUCKET || "blendn-media-staging"

/**
 * A square master per `docs/MEDIA.md`, from a host that serves the phone.
 *
 * History, so nobody walks it again: this was `picsum.photos`, then
 * `loremflickr` for photographs chosen by keyword (a nightclub event got a
 * nightclub). On 2026-09-24 loremflickr began answering every non-browser
 * client with a 401 "Bot check" page, and the phone's image loader is a
 * non-browser client, so every hotlinked cover went blank (SCRUM-285).
 * Unsplash's search sits behind the same kind of check, `source.unsplash.com`
 * is retired, and Wikimedia refuses okhttp's user agent. picsum answers okhttp
 * and CFNetwork with an image — probed for every subject on 2026-09-24.
 *
 * The price is that a hotlinked cover is arbitrary stock again. The events
 * that are judged as design — `TIGRIS_HOSTED` in seed-qa.ts — keep their
 * keyword photographs, which are in our bucket and are never replaced (see
 * `mirrorToTigris`). A placeholder that does not load is worse than either.
 */
export const SEED_COVER_SIZE = 1600
export const cover = (subject: string): string =>
  `https://picsum.photos/seed/blendn-${subject}/${SEED_COVER_SIZE}/${SEED_COVER_SIZE}`

/** The host seeded covers came from until it bot-checked the phone. */
export const RETIRED_COVER_HOST = "loremflickr.com"
const RETIRED_COVER = /^https?:\/\/loremflickr\.com\/\d+\/\d+\/([a-z]+)/i

/**
 * The live equivalent of a cover still on the retired host, or null. A
 * dashboard duplicate or a hand-made test event copies the seeded URL, so the
 * dead host outlives the seed's own rows; the first keyword stands in for the
 * subject.
 */
export const revivedCover = (url: string | null): string | null => {
  const subject = url?.match(RETIRED_COVER)?.[1]
  return subject ? cover(subject.toLowerCase()) : null
}

/** Long enough for a slow host, short enough that one cannot stall a refresh. */
const FETCH_TIMEOUT_MS = 10_000

async function inBucket(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).ok
  } catch {
    return false
  }
}

/**
 * Copy a remote asset into our bucket and hand back the public URL.
 *
 * **An object already in the bucket is used as it is.** Keys carry the event
 * slug and seeded assets never change under their key, so there is nothing to
 * refresh — and checking first is what stops a re-seed without credentials
 * from writing the hotlink over a bucket URL that still serves. That is how
 * the six mirrored covers ended up pointing at loremflickr when it went dark.
 *
 * Returns the original URL unchanged when the object is missing and Tigris is
 * not configured, or the copy fails, and says so. A seed that dies because an
 * object store was unreachable would leave the world half-built.
 */
export async function mirrorToTigris(
  sourceUrl: string,
  key: string,
  contentType: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const hosted = `https://${SEED_BUCKET}.fly.storage.tigris.dev/${key}`
  if (await inBucket(hosted)) return hosted

  const { TIGRIS_ENDPOINT: endpoint, TIGRIS_ACCESS_KEY: accessKeyId, TIGRIS_SECRET_KEY: secretAccessKey } = env
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.log(`  ~  ${key} is not in ${SEED_BUCKET} and Tigris is not configured — stays hotlinked`)
    return sourceUrl
  }

  try {
    const res = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`source ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())

    const client = new S3Client({
      endpoint,
      region: env.TIGRIS_REGION || "auto",
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,
    })
    await client.send(
      new PutObjectCommand({
        Bucket: SEED_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Long, because a seeded asset never changes under its key — the key
        // carries the event slug, so a new asset is a new key.
        CacheControl: "public, max-age=31536000, immutable",
      })
    )
    return hosted
  } catch (error) {
    console.log(`  ~  mirror failed for ${key} (${String(error)}) — staying hotlinked`)
    return sourceUrl
  }
}
