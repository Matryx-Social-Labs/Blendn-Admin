/*
 * Objects no profile points at leave the public bucket (SCRUM-730): a replaced
 * main photo, the raw upload a sealed copy was made from, a blur two writes
 * raced, an object from an old client bug. The bucket is an in-memory list here
 * (the real listing and delete are mocked); the references are real rows.
 */
const bucket = new Map<string, Date>()
const deleted: string[] = []
let failOn: string | null = null
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  listPublicObjects: jest.fn(async (prefix: string, token?: string) => {
    const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort()
    const start = token ? Number(token) : 0
    const page = keys.slice(start, start + 1000)
    return {
      objects: page.map((key) => ({ key, lastModified: bucket.get(key)! })),
      next: start + 1000 < keys.length ? String(start + 1000) : undefined,
    }
  }),
  deleteFile: jest.fn(async (key: string) => {
    if (failOn === key) throw new Error("storage down")
    bucket.delete(key)
    deleted.push(key)
  }),
}))

import {
  MAX_DELETES_PER_PASS,
  ORPHAN_GRACE_MS,
  SANITY_FLOOR,
  orphanModeFromEnv,
  stopOrphanPhotoSweeper,
  sweepOrphanPhotos,
} from "@/lib/photo-orphans"
import { db, closeDb, makeUser, onboard } from "./helpers"

const host = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const users: string[] = []
const NOW = new Date()
const OLD = new Date(NOW.getTime() - 2 * ORPHAN_GRACE_MS)
const YOUNG = new Date(NOW.getTime() - ORPHAN_GRACE_MS / 4)

afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})
beforeEach(() => {
  bucket.clear()
  deleted.length = 0
  failOn = null
  stopOrphanPhotoSweeper()
})

const put = (key: string, at: Date = OLD) => bucket.set(key, at)
async function person(photos: string[] = [], blur: string | null = null, image: string | null = null) {
  const id = await makeUser("orph")
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { photos, blur_photo: blur } })
  if (image) await db.user.update({ where: { id }, data: { image } })
  return id
}
const url = (key: string) => `${host}/${key}`
const pass = () => sweepOrphanPhotos({ now: NOW, mode: "delete" })

describe("the orphan photo sweep", () => {
  it("waits at least three days before judging an object: a photo can be put back from another device", () => {
    expect(ORPHAN_GRACE_MS).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000)
  })

  it("deletes what no profile points at, and keeps everything one does (photos, blur, image)", async () => {
    const id = await person()
    const [main, second, blur, image] = ["main-sealed", "second-sealed", "blur-sealed", "social-sealed"].map((n) => `profile/${id}/${n}`)
    await db.profiles.update({ where: { id }, data: { photos: [url(main), url(second)], blur_photo: url(blur) } })
    await db.user.update({ where: { id }, data: { image: url(image) } })
    const replaced = `profile/${id}/replaced-sealed`
    const rawUpload = `profile/${id}/1790641297767-cfg6ta-photo.jpg`
    for (const k of [main, second, blur, image, replaced, rawUpload]) put(k)
    const result = await pass()
    expect(result).toMatchObject({ judged: 6, orphans: 2, deleted: 2 })
    expect(deleted.sort()).toEqual([rawUpload, replaced].sort())
    expect([...bucket.keys()].sort()).toEqual([main, second, blur, image].sort())
  })

  it("keeps an orphan younger than the grace window: an upload in flight or a seal not yet attached", async () => {
    const id = await person()
    put(`profile/${id}/young-sealed`, YOUNG)
    put(`profile/${id}/old-sealed`)
    await pass()
    expect(deleted).toEqual([`profile/${id}/old-sealed`])
    expect(bucket.has(`profile/${id}/young-sealed`)).toBe(true)
  })

  it("recognises a referenced key however its URL is spelled", async () => {
    const id = await person()
    const key = `profile/${id}/spelled-sealed`
    const bucketName = process.env.TIGRIS_BUCKET || "blendn-media"
    await db.profiles.update({ where: { id }, data: { photos: [`${host}/${key}?versionId=3`, `https://s3.example/${bucketName}/profile/${id}/pathstyle-sealed`] } })
    put(key)
    put(`profile/${id}/pathstyle-sealed`)
    await pass()
    expect(deleted).toEqual([])
  })

  it("never deletes a photo moderation pulled whose withdrawal failed, or one it has not judged yet (the retention hold)", async () => {
    const id = await person()
    const pulled = `profile/${id}/pulled-sealed`
    const unjudged = `profile/${id}/unjudged-sealed`
    const clean = `profile/${id}/clean-orphan-sealed`
    for (const k of [pulled, unjudged, clean]) put(k)
    await db.photo_checks.createMany({
      data: [
        { url: url(pulled), user_id: id, checked: true, hidden: true },
        { url: url(unjudged), user_id: id, checked: false },
        { url: url(clean), user_id: id, checked: true },
      ],
    })
    await pass()
    expect(deleted).toEqual([clean])
    expect(bucket.has(pulled)).toBe(true)
    expect(bucket.has(unjudged)).toBe(true)
    await db.photo_checks.deleteMany({ where: { user_id: id } })
  })

  it("reads a reference that is a bare key, an old bucket's path-style URL, or another person's folder as a reference", async () => {
    const id = await person()
    const other = await person()
    const [bare, oldBucket, theirs] = [`profile/${id}/bare-sealed`, `profile/${id}/oldbucket-sealed`, `profile/${other}/shared-sealed`]
    await db.profiles.update({ where: { id }, data: { photos: [bare, `https://s3.example/old-bucket-name/${oldBucket}`, url(theirs)] } })
    for (const k of [bare, oldBucket, theirs]) put(k)
    await pass()
    expect(deleted).toEqual([])
  })

  it("deletes the objects of an account that no longer exists", async () => {
    const gone = "cmgoneuser000000000000000"
    put(`profile/${gone}/a-sealed`)
    put(`profile/${gone}/b-sealed`)
    await pass()
    expect(deleted.sort()).toEqual([`profile/${gone}/a-sealed`, `profile/${gone}/b-sealed`])
  })

  it("is a dry run unless asked to delete: it counts and logs and touches nothing", async () => {
    const id = await person()
    put(`profile/${id}/orphan-sealed`)
    expect(orphanModeFromEnv(undefined)).toBe("log")
    expect(orphanModeFromEnv("")).toBe("log")
    expect(orphanModeFromEnv("delete")).toBe("delete")
    const result = await sweepOrphanPhotos({ now: NOW, mode: "log" })
    expect(result).toMatchObject({ orphans: 1, deleted: 0 })
    expect(deleted).toEqual([])
    expect(await sweepOrphanPhotos({ now: NOW, mode: "off" })).toMatchObject({ listed: 0, deleted: 0 })
  })

  it("ignores keys that are not profile/<uid>/<name>", async () => {
    put("profile/loose-file")
    put("profile//nameless")
    put("profile/someone/")
    await pass()
    expect(deleted).toEqual([])
  })

  it("refuses a pass in which nearly everything looks orphaned: that is a broken reference read, not a bucket", async () => {
    const id = await person()
    for (let i = 0; i < SANITY_FLOOR + 10; i++) put(`profile/${id}/n${i}-sealed`)
    const result = await pass()
    expect(result.refused).toBe(true)
    expect(deleted).toEqual([])

    // A big bucket with a minority of orphans is fine.
    const refs = Array.from({ length: SANITY_FLOOR }, (_, i) => `profile/${id}/ok${i}-sealed`)
    await db.profiles.update({ where: { id }, data: { photos: refs.map(url) } })
    refs.forEach((k) => put(k))
    const fine = await pass()
    expect(fine.refused).toBe(false)
    expect(fine.deleted).toBe(SANITY_FLOOR + 10)
  })

  it("deletes at most MAX_DELETES_PER_PASS and carries on at the next pass", async () => {
    const id = await person()
    // A reference-bearing neighbour keeps the share under the sanity ceiling.
    const refs = Array.from({ length: MAX_DELETES_PER_PASS * 3 }, (_, i) => `profile/${id}/ref${i}-sealed`)
    await db.profiles.update({ where: { id }, data: { photos: refs.map(url) } })
    refs.forEach((k) => put(k))
    const orphanIds = Array.from({ length: MAX_DELETES_PER_PASS + 20 }, (_, i) => `profile/${id}/o${i}-sealed`)
    orphanIds.forEach((k) => put(k))
    const first = await pass()
    expect(first.deleted).toBe(MAX_DELETES_PER_PASS)
    stopOrphanPhotoSweeper()
    const second = await pass()
    expect(second.deleted).toBe(20)
    expect(deleted).toHaveLength(MAX_DELETES_PER_PASS + 20)
  })

  it("keeps going when one delete fails, and says so", async () => {
    const id = await person()
    put(`profile/${id}/a-sealed`)
    put(`profile/${id}/b-sealed`)
    failOn = `profile/${id}/a-sealed`
    const result = await pass()
    expect(result).toMatchObject({ orphans: 2, deleted: 1 })
    expect(bucket.has(`profile/${id}/a-sealed`)).toBe(true)
  })

  it("reads a big bucket across passes with a cursor, then starts again", async () => {
    const id = await person()
    const refs = Array.from({ length: 5200 }, (_, i) => `profile/${id}/r${String(i).padStart(5, "0")}`)
    refs.forEach((k) => put(k))
    await db.profiles.update({ where: { id }, data: { photos: refs.map(url) } })
    const first = await sweepOrphanPhotos({ now: NOW, mode: "log" })
    expect(first).toMatchObject({ listed: 5000, complete: false })
    const second = await sweepOrphanPhotos({ now: NOW, mode: "log" })
    expect(second).toMatchObject({ listed: 200, complete: true })
    const third = await sweepOrphanPhotos({ now: NOW, mode: "log" })
    expect(third.listed).toBe(5000)
  })
})
