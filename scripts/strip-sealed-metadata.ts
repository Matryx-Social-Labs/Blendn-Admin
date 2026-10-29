import { S3Client } from "@aws-sdk/client-s3"

import { sealedTargets, stripSealedMetadata } from "../lib/sealed-metadata-backfill"
import { bucketStore } from "../lib/sealed-metadata-store"

/**
 * Strips EXIF / GPS from photos sealed before SCRUM-626 (SCRUM-672).
 *
 *   TIGRIS_*=… npx tsx scripts/strip-sealed-metadata.ts            # dry run: prints the counts and the keys
 *   TIGRIS_*=… npx tsx scripts/strip-sealed-metadata.ts --apply
 *
 * Reads TIGRIS_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION / _BUCKET /
 * _PRIVATE_BUCKET from the environment (the target environment's values from
 * Railway). Staging first, then prod. The first line printed names the mode and
 * both buckets, so check it is the environment you meant. Keys carry user ids:
 * keep the output out of tickets.
 *
 * Exits non-zero when anything was left as it was that should not be: a failure,
 * a lost race (run it again), or an object that is not a readable photo and may
 * still hold a position. Through `npx tsx`, not an npm script: npm 11 eats `--apply`.
 */
const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function main() {
  const apply = process.argv.includes("--apply")
  const publicBucket = need("TIGRIS_BUCKET")
  const privateBucket = need("TIGRIS_PRIVATE_BUCKET")
  if (publicBucket === privateBucket) throw new Error("TIGRIS_BUCKET and TIGRIS_PRIVATE_BUCKET are the same bucket")
  const client = new S3Client({
    endpoint: need("TIGRIS_ENDPOINT"),
    region: process.env.TIGRIS_REGION || "auto",
    credentials: { accessKeyId: need("TIGRIS_ACCESS_KEY"), secretAccessKey: need("TIGRIS_SECRET_KEY") },
    forcePathStyle: true,
  })
  console.log(`${apply ? "APPLY" : "DRY RUN"} public=${publicBucket} private=${privateBucket}`)
  const report = await stripSealedMetadata(sealedTargets(bucketStore(client, publicBucket), bucketStore(client, privateBucket)), { apply })
  const counts = { ...report, dirtyKeys: report.dirtyKeys.length, notAnImageKeys: report.notAnImageKeys.length, racedKeys: report.racedKeys.length, failed: report.failed.length }
  console.log(JSON.stringify(counts))
  for (const key of report.dirtyKeys) console.log(`${apply ? "strips" : "would strip"} ${key}`)
  for (const key of report.notAnImageKeys) console.log(`not a readable photo, left as is: ${key}`)
  for (const key of report.racedKeys) console.log(`changed under the sweep, not written: ${key}`)
  for (const f of report.failed) console.log(`failed ${f.key}: ${f.error}`)
  if (report.failed.length + report.racedKeys.length + report.notAnImageKeys.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
