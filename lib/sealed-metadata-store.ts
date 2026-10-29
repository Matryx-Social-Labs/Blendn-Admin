import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"

import type { ObjectStore } from "./sealed-metadata-backfill"

/** Per storage call, so one hung request cannot stall the whole sweep. */
const CALL_TIMEOUT_MS = 30_000

const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0
const timeout = () => ({ abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) })

/**
 * One bucket as the sweep's store (SCRUM-672).
 *
 * `replace` sends `If-Match` with the ETag that was read. Tigris enforces it
 * on PutObject (measured on staging 2026-10-29: a stale ETag answers 412, a
 * deleted key 404, and neither writes), which is what keeps an account erased
 * mid-sweep erased. Those, and 409, mean "changed"; anything else is a failure.
 */
export function bucketStore(client: Pick<S3Client, "send">, Bucket: string): ObjectStore {
  return {
    async *keys(Prefix) {
      let ContinuationToken: string | undefined
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }), timeout())
        for (const o of page.Contents ?? []) if (o.Key) yield o.Key
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (ContinuationToken)
    },
    async read(Key) {
      try {
        const got = await client.send(new GetObjectCommand({ Bucket, Key }), timeout())
        if (!got.Body || !got.ETag) throw new Error(`${Key}: storage answered without a body or an ETag`)
        return {
          bytes: await got.Body.transformToByteArray(),
          etag: got.ETag,
          headers: { contentType: got.ContentType ?? "", cacheControl: got.CacheControl, metadata: got.Metadata ?? {} },
        }
      } catch (error) {
        if (statusOf(error) === 404) return null
        throw error
      }
    },
    async replace(Key, Body, headers, etag) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            IfMatch: etag,
            ContentType: headers.contentType,
            CacheControl: headers.cacheControl,
            Metadata: headers.metadata,
          }),
          timeout()
        )
        return "written"
      } catch (error) {
        if ([404, 409, 412].includes(statusOf(error))) return "changed"
        throw error
      }
    },
  }
}
