import { stripImageMetadata } from "./image-metadata"

/**
 * Photos sealed before SCRUM-626 keep their EXIF (SCRUM-672).
 *
 * `sealUpload` strips what it seals from then on. This is the sweep for what
 * was sealed before: profile photos in the public bucket, DM / room media in
 * the private one, and the copies a pulled profile photo or an older chat seal
 * left in either (`chat/<id>/…-sealed` before SCRUM-448, `profile/<id>/…-sealed`
 * withdrawn to the private bucket). It re-writes an object stripped at the SAME key with the
 * SAME headers, so no row and no cached URL changes, and only when stripping
 * would change its bytes.
 *
 * The store is a seam so the rules are testable without a bucket;
 * `scripts/strip-sealed-metadata.ts` is the S3 side.
 *
 * A sweep reads, then writes some time later, and a person can erase their
 * account in between. A write that puts a deleted photo back is worse than
 * the leak it fixes, so `replace` is conditional on the bytes it read: when
 * the object has gone or been replaced it answers "changed" and writes
 * nothing.
 */
export interface ObjectHeaders {
  contentType: string
  cacheControl: string | undefined
  metadata: Record<string, string>
}
export interface StoredObject {
  bytes: Uint8Array
  headers: ObjectHeaders
  etag: string
}
export interface ObjectStore {
  keys(prefix: string): AsyncIterable<string>
  /** null when the object is not there. */
  read(key: string): Promise<StoredObject | null>
  replace(key: string, bytes: Uint8Array, headers: ObjectHeaders, etag: string): Promise<"written" | "changed">
}
export interface Target {
  store: ObjectStore
  prefix: string
  isSealed: (key: string) => boolean
}

/** What `sealUpload` has named a copy: `…-sealed` under profile/ and the old chat/<id>/, `chat/sealed/<uuid>` since SCRUM-448. */
const isSealedKey = (key: string) => key.endsWith("-sealed") || key.startsWith("chat/sealed/")

/** Both buckets under both folders: a raw upload is not a seal and is left to the seal that will read it. */
export const sealedTargets = (publicStore: ObjectStore, privateStore: ObjectStore): Target[] =>
  [publicStore, privateStore].flatMap((store) => ["profile/", "chat/"].map((prefix) => ({ store, prefix, isSealed: isSealedKey })))

export interface BackfillReport {
  scanned: number
  /** Sealed photos whose bytes stripping would change, and which. */
  dirty: number
  dirtyKeys: string[]
  rewritten: number
  /** Not a JPEG, PNG or WebP that walks to its end: left as it is, and named, since it may still hold a position. */
  notAnImageKeys: string[]
  /** Erased or replaced between the read and the write: not written. */
  racedKeys: string[]
  /** Listed, then gone before it was read. */
  vanished: number
  bytesRemoved: number
  failed: { key: string; error: string }[]
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b))

/**
 * Visit every sealed object. `apply: false` only counts. One object failing
 * is reported and does not stop the rest.
 */
export async function stripSealedMetadata(targets: Target[], { apply }: { apply: boolean }): Promise<BackfillReport> {
  const report: BackfillReport = { scanned: 0, dirty: 0, dirtyKeys: [], rewritten: 0, notAnImageKeys: [], racedKeys: [], vanished: 0, bytesRemoved: 0, failed: [] }
  for (const { store, prefix, isSealed } of targets) {
    for await (const key of store.keys(prefix)) {
      if (!isSealed(key)) continue
      report.scanned++
      try {
        await visit(store, key, apply, report)
      } catch (error) {
        report.failed.push({ key, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return report
}

async function visit(store: ObjectStore, key: string, apply: boolean, report: BackfillReport): Promise<void> {
  const held = await store.read(key)
  if (!held) {
    report.vanished++
    return
  }
  const clean = stripImageMetadata(held.bytes)
  if (!clean) {
    report.notAnImageKeys.push(key)
    return
  }
  if (sameBytes(clean.bytes, held.bytes)) return
  report.dirty++
  report.dirtyKeys.push(key)
  report.bytesRemoved += held.bytes.length - clean.bytes.length
  if (!apply) return
  const outcome = await store.replace(key, clean.bytes, { ...held.headers, contentType: clean.contentType }, held.etag)
  if (outcome === "written") report.rewritten++
  else report.racedKeys.push(key)
}
