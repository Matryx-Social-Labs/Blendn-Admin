/*
 * Photos sealed before SCRUM-626 lose their EXIF (SCRUM-672).
 *
 * `sealUpload` strips what is sealed from now on; this sweeps what was sealed
 * before. Against an in-memory store, so the three promises are pinned without
 * a bucket: a dry run changes nothing, an apply rewrites only what stripping
 * would change (same key, same headers), and an object that was erased or
 * replaced while the sweep held its bytes is never put back.
 */
import { type ObjectStore, type StoredObject, sealedTargets, stripSealedMetadata } from "@/lib/sealed-metadata-backfill"
import { bucketStore } from "@/lib/sealed-metadata-store"
import { bytesOf, has, JPEG_WITH_GPS, METADATA, PNG_WITH_GPS, WEBP_WITH_GPS } from "./support/gps-photos"

const HEADERS = { contentType: "image/jpeg", cacheControl: "no-cache", metadata: { "uploaded-by": "u1" } }
const OTHER_HEADERS = { contentType: "image/png", cacheControl: "max-age=60", metadata: {} }

function memoryStore(initial: Record<string, Uint8Array>, headers: StoredObject["headers"] = HEADERS) {
  const objects = new Map<string, StoredObject>(
    Object.entries(initial).map(([key, bytes]) => [key, { bytes, etag: `e0-${key}`, headers }])
  )
  const writes: string[] = []
  const store: ObjectStore & { objects: typeof objects; writes: string[]; beforeWrite?: (key: string) => void } = {
    objects,
    writes,
    async *keys(prefix) {
      for (const key of [...objects.keys()].sort()) if (key.startsWith(prefix)) yield key
    },
    async read(key) {
      return objects.get(key) ?? null
    },
    async replace(key, bytes, headers, etag) {
      store.beforeWrite?.(key)
      const held = objects.get(key)
      if (!held || held.etag !== etag) return "changed"
      objects.set(key, { bytes, headers, etag: `e1-${key}` })
      writes.push(key)
      return "written"
    },
  }
  return store
}

const PROFILE = "profile/u1/1760000000000-abc123-sealed"
const CHAT = "chat/sealed/6f0f5c9e-0000-4000-8000-000000000001"
const targetsOf = (publicStore: ObjectStore, privateStore: ObjectStore = memoryStore({})) => sealedTargets(publicStore, privateStore)
const WITHDRAWN = "profile/u2/1760000000001-def456-sealed"
const OLD_CHAT = "chat/u1/1760000000002-ghi789-sealed"

describe("stripSealedMetadata", () => {
  test("a dry run counts what stripping would change, names it, and writes nothing", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    const chat = memoryStore({ [CHAT]: bytesOf(PNG_WITH_GPS) })
    const before = [store.objects.get(PROFILE)!.bytes.length, chat.objects.get(CHAT)!.bytes.length]

    const report = await stripSealedMetadata(targetsOf(store, chat), { apply: false })

    expect(report).toMatchObject({ scanned: 2, dirty: 2, dirtyKeys: [PROFILE, CHAT], rewritten: 0 })
    expect([store.objects.get(PROFILE)!.bytes.length, chat.objects.get(CHAT)!.bytes.length]).toEqual(before)
    expect([...store.writes, ...chat.writes]).toEqual([])
    expect(has(store.objects.get(PROFILE)!.bytes, "GPSLatitude")).toBe(true)
  })

  test("apply rewrites each dirty object at its own key with its own headers, and no GPS is left", async () => {
    const photos = { [PROFILE]: bytesOf(JPEG_WITH_GPS), [WITHDRAWN]: bytesOf(WEBP_WITH_GPS) }
    const publicStore = memoryStore(photos, HEADERS)
    const privateStore = memoryStore({ [CHAT]: bytesOf(PNG_WITH_GPS) }, OTHER_HEADERS)
    const sizeBefore = Object.values(photos).reduce((n, b) => n + b.length, 0) + bytesOf(PNG_WITH_GPS).length

    const report = await stripSealedMetadata(targetsOf(publicStore, privateStore), { apply: true })

    expect(report).toMatchObject({ scanned: 3, dirty: 3, rewritten: 3, racedKeys: [], failed: [] })
    const kept = [publicStore.objects.get(PROFILE)!, publicStore.objects.get(WITHDRAWN)!, privateStore.objects.get(CHAT)!]
    expect(report.bytesRemoved).toBe(sizeBefore - kept.reduce((n, o) => n + o.bytes.length, 0))
    for (const o of kept) expect(METADATA.filter((m) => has(o.bytes, m))).toEqual([])
    expect(kept.map((o) => o.headers)).toEqual([HEADERS, { ...HEADERS, contentType: "image/webp" }, OTHER_HEADERS])
  })

  test("a second apply finds nothing to do", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    await stripSealedMetadata(targetsOf(store), { apply: true })
    store.writes.length = 0

    const again = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(again).toMatchObject({ scanned: 1, dirty: 0, rewritten: 0 })
    expect(store.writes).toEqual([])
  })

  test("public and private are swept in their own bucket, under both folders", async () => {
    const publicStore = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    const privateStore = memoryStore({ [CHAT]: bytesOf(PNG_WITH_GPS), [OLD_CHAT]: bytesOf(JPEG_WITH_GPS), [WITHDRAWN]: bytesOf(WEBP_WITH_GPS) })

    const report = await stripSealedMetadata(targetsOf(publicStore, privateStore), { apply: true })

    expect(report.scanned).toBe(4)
    expect(publicStore.writes).toEqual([PROFILE])
    expect(privateStore.writes.sort()).toEqual([CHAT, OLD_CHAT, WITHDRAWN].sort())
  })

  test("a raw upload is not a seal and is left alone", async () => {
    const raw = "profile/u1/1760000000000-abc123-photo.jpg"
    const loose = "chat/u1/1760000000000-abc123-photo.jpg"
    const store = memoryStore({ [raw]: bytesOf(JPEG_WITH_GPS), [loose]: bytesOf(JPEG_WITH_GPS), [PROFILE]: bytesOf(JPEG_WITH_GPS) })

    const report = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(report.scanned).toBe(1)
    expect(store.writes).toEqual([PROFILE])
  })

  test("a photo that does not walk to its end is named, not rewritten, and not counted clean", async () => {
    const truncated = bytesOf(JPEG_WITH_GPS).subarray(0, 200)
    const store = memoryStore({ [PROFILE]: truncated })
    const chat = memoryStore({ [CHAT]: new Uint8Array([1, 2, 3, 4]) })

    const report = await stripSealedMetadata(targetsOf(store, chat), { apply: true })

    expect(report).toMatchObject({ scanned: 2, dirty: 0, rewritten: 0, notAnImageKeys: [PROFILE, CHAT] })
    expect([...store.writes, ...chat.writes]).toEqual([])
    expect(store.objects.get(PROFILE)!.bytes).toEqual(truncated)
  })

  test("an object erased after it was read is not put back, and is named", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    store.beforeWrite = (key) => void store.objects.delete(key)

    const report = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(report).toMatchObject({ dirty: 1, rewritten: 0, racedKeys: [PROFILE] })
    expect(store.objects.has(PROFILE)).toBe(false)
  })

  test("an object replaced after it was read is left as the new owner wrote it", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    const theirs = bytesOf(PNG_WITH_GPS)
    store.beforeWrite = (key) => void store.objects.set(key, { bytes: theirs, etag: "theirs", headers: HEADERS })

    const report = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(report).toMatchObject({ rewritten: 0, racedKeys: [PROFILE] })
    expect(store.objects.get(PROFILE)!.bytes).toBe(theirs)
  })

  test("an object listed and gone before it is read is counted, not failed", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS) })
    store.read = async () => null

    const report = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(report).toMatchObject({ scanned: 1, vanished: 1, dirty: 0, failed: [] })
  })

  test("one object failing does not stop the rest, and is reported", async () => {
    const store = memoryStore({ [PROFILE]: bytesOf(JPEG_WITH_GPS), [WITHDRAWN]: bytesOf(WEBP_WITH_GPS) })
    const read = store.read
    store.read = async (key) => {
      if (key === PROFILE) throw new Error("storage down")
      return read(key)
    }

    const report = await stripSealedMetadata(targetsOf(store), { apply: true })

    expect(report).toMatchObject({ rewritten: 1, failed: [{ key: PROFILE, error: "storage down" }] })
    expect(store.writes).toEqual([WITHDRAWN])
  })
})

/*
 * The S3 side, against a client that records what it is sent. The guard that
 * keeps an erased photo erased is the conditional write, so it is pinned here
 * and not only in the loop above.
 */
describe("bucketStore", () => {
  type Sent = { name: string; input: Record<string, unknown> }
  const clientAnswering = (answer: (sent: Sent) => unknown) => {
    const sent: Sent[] = []
    return {
      sent,
      send: jest.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const call = { name: command.constructor.name, input: command.input }
        sent.push(call)
        return answer(call)
      }),
    }
  }
  const refusal = (httpStatusCode: number) => Object.assign(new Error(`status ${httpStatusCode}`), { $metadata: { httpStatusCode } })
  const body = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes })

  test("keys follows the continuation token to the last page", async () => {
    const pages: Record<string, unknown> = {
      first: { Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "t1" },
      t1: { Contents: [{ Key: "b" }, { Key: "c" }], IsTruncated: false },
    }
    const client = clientAnswering((s) => pages[(s.input.ContinuationToken as string | undefined) ?? "first"])

    const keys: string[] = []
    for await (const key of bucketStore(client, "bkt").keys("profile/")) keys.push(key)

    expect(keys).toEqual(["a", "b", "c"])
    expect(client.sent.map((s) => s.input.Prefix)).toEqual(["profile/", "profile/"])
  })

  test("read hands back the bytes, the ETag and the headers it must preserve", async () => {
    const client = clientAnswering(() => ({ Body: body(new Uint8Array([9])), ETag: '"abc"', ContentType: "image/jpeg", CacheControl: "no-cache", Metadata: { "uploaded-by": "u1" } }))

    const held = await bucketStore(client, "bkt").read("k")

    expect(held).toEqual({ bytes: new Uint8Array([9]), etag: '"abc"', headers: { contentType: "image/jpeg", cacheControl: "no-cache", metadata: { "uploaded-by": "u1" } } })
  })

  test("read answers null for a missing object and throws for any other refusal", async () => {
    await expect(bucketStore(clientAnswering(() => Promise.reject(refusal(404))), "bkt").read("k")).resolves.toBeNull()
    await expect(bucketStore(clientAnswering(() => Promise.reject(refusal(500))), "bkt").read("k")).rejects.toThrow("status 500")
  })

  test("replace writes only if the object is still the one that was read, with its headers", async () => {
    const client = clientAnswering(() => ({}))

    const outcome = await bucketStore(client, "bkt").replace("k", new Uint8Array([1]), HEADERS, '"abc"')

    expect(outcome).toBe("written")
    expect(client.sent[0]).toMatchObject({
      name: "PutObjectCommand",
      input: { Bucket: "bkt", Key: "k", IfMatch: '"abc"', ContentType: "image/jpeg", CacheControl: "no-cache", Metadata: { "uploaded-by": "u1" } },
    })
  })

  test.each([404, 409, 412])("replace answers changed when storage says %i", async (status) => {
    const client = clientAnswering(() => Promise.reject(refusal(status)))

    await expect(bucketStore(client, "bkt").replace("k", new Uint8Array([1]), HEADERS, '"abc"')).resolves.toBe("changed")
  })

  test.each([403, 500])("replace throws when storage says %i, so the object is reported as failed", async (status) => {
    const client = clientAnswering(() => Promise.reject(refusal(status)))

    await expect(bucketStore(client, "bkt").replace("k", new Uint8Array([1]), HEADERS, '"abc"')).rejects.toThrow(`status ${status}`)
  })
})
