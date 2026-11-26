/*
 * Objects no profile points at leave the public bucket (SCRUM-730): a replaced
 * main photo, the raw upload a sealed copy was made from, a blur two writes
 * raced, an object from an old client bug. The bucket is an in-memory list here
 * (the real listing and delete are mocked); the references are real rows.
 */
const bucket = new Map<string, Date>()
/** The private bucket, where chat uploads live since SCRUM-427. */
const chatBucket = new Map<string, Date>()
const deleted: string[] = []
let failOn: string | null = null
let listFails = false
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  listPublicObjects: jest.fn(async (prefix: string, token?: string, name?: string) => {
    if (listFails) throw new Error("storage down")
    const { bucketFor } = jest.requireActual("@/lib/tigris")
    const store = name === undefined || name === bucketFor("profile") ? bucket : name === bucketFor("chat") ? chatBucket : null
    if (!store) throw new Error(`no such bucket ${name}`)
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
    const start = token ? Number(token) : 0
    const page = keys.slice(start, start + 1000)
    return {
      objects: page.map((key) => ({ key, lastModified: store.get(key)! })),
      next: start + 1000 < keys.length ? String(start + 1000) : undefined,
    }
  }),
  deleteFile: jest.fn(async (key: string) => {
    if (failOn === key) throw new Error("storage down")
    bucket.delete(key)
    chatBucket.delete(key)
    deleted.push(key)
  }),
}))

import {
  MAX_DELETES_PER_PASS,
  ORPHAN_GRACE_MS,
  SANITY_FLOOR,
  orphanModeFromEnv,
  stopOrphanPhotoSweeper,
  sweepAllOrphans,
  sweepOrphanChatUploads,
  sweepOrphanPhotos,
} from "@/lib/photo-orphans"
import { db as appDb } from "@/lib/db"
import { logger } from "@/lib/logger"
import { bucketFor } from "@/lib/tigris"
import { db, cleanup, closeDb, makeEvent, makeUser, onboard } from "./helpers"

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
  chatBucket.clear()
  deleted.length = 0
  failOn = null
  listFails = false
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

/*
 * Raw chat uploads that were never sent (SCRUM-1387). Sending seals an upload:
 * the message stores `chat/sealed/<uuid>` and the raw `chat/<uid>/<name>` is
 * deleted. An upload nobody sends stays in the private bucket, original
 * metadata and all, for ever. Only rows from before sealing name a raw key, so
 * the sweep reads every place one can be named and keeps what any of them do.
 */
describe("the unsent chat upload sweep", () => {
  const chatUsers: string[] = []
  const chatEvents: string[] = []
  const auditIds: string[] = []
  const privateHost = `https://${bucketFor("chat")}.fly.storage.tigris.dev`
  const putChat = (key: string, at: Date = OLD) => chatBucket.set(key, at)
  const rawKey = (uid: string, name = "photo.jpg") => `chat/${uid}/1790641297767-cfg6ta-${name}`
  const chatPass = (mode: "log" | "delete" = "delete") => sweepOrphanChatUploads({ now: NOW, mode })

  async function sender() {
    const id = await makeUser("chat")
    chatUsers.push(id)
    await onboard(id)
    return id
  }
  async function dm(from: string, mediaUrl: string) {
    const to = await sender()
    const [user1_id, user2_id] = [from, to].sort()
    const c = await db.private_conversations.create({ data: { user1_id, user2_id, user1_pseudonym: "A", user2_pseudonym: "B" }, select: { id: true } })
    await db.private_messages.create({ data: { conversation_id: c.id, sender_id: from, message_text: "", media_url: mediaUrl, media_type: "image" } })
  }
  async function roomMessage(from: string, metadata: object) {
    const eventId = await makeEvent(from)
    chatEvents.push(eventId)
    const room = await db.chat_groups.create({ data: { kind: "event", event_id: eventId, name: "Room" }, select: { id: true } })
    await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: from, content: "", metadata } })
    return eventId
  }
  /** The task's read-back, corrected: a room message's media is in `metadata`, a DM's in `media_url`. */
  async function rowsNaming(key: string) {
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM private_messages WHERE media_url LIKE '%' || ${key} || '%')
           + (SELECT count(*) FROM chat_messages WHERE metadata::text LIKE '%' || ${key} || '%') AS n`
    return Number(n)
  }

  afterAll(async () => {
    await db.retained_report_media.deleteMany({ where: { user_id: { in: chatUsers } } })
    await db.audit_logs.deleteMany({ where: { id: { in: auditIds } } })
    await cleanup(chatUsers, chatEvents)
  })
  afterEach(() => jest.restoreAllMocks())

  it("deletes a 4-day-old upload no row names, from the chat bucket, and only counts it in log mode", async () => {
    const uid = await sender()
    const key = rawKey(uid)
    putChat(key, new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000))

    const dry = await chatPass("log")
    expect(dry).toMatchObject({ mode: "log", judged: 1, orphans: 1, deleted: 0, refused: false })
    expect(chatBucket.has(key)).toBe(true)

    const info = jest.spyOn(logger, "info")
    const result = await chatPass("delete")
    expect(result).toMatchObject({ judged: 1, orphans: 1, deleted: 1 })
    expect(deleted).toEqual([key])
    expect([...chatBucket.keys()].filter((k) => k.startsWith(`chat/${uid}/`))).toEqual([])
    expect(await rowsNaming(key)).toBe(0)
    // The log line says which sweep it was, so staging's dry run reads chat apart from profile.
    expect(info).toHaveBeenCalledWith(expect.stringContaining("chat"), expect.objectContaining({ orphans: 1, deleted: 1 }))
  })

  it("lists the private bucket, where chat lives, not the public one", async () => {
    const uid = await sender()
    bucket.set(rawKey(uid), OLD)
    expect(await chatPass()).toMatchObject({ listed: 0, deleted: 0 })
    expect(bucket.has(rawKey(uid))).toBe(true)
  })

  it("keeps an upload a DM names, however the URL is spelled", async () => {
    const uid = await sender()
    const [virtual, query, pathStyle, oldPublic] = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((n) => rawKey(uid, n))
    await dm(uid, `${privateHost}/${virtual}`)
    await dm(uid, `${privateHost}/${query}?X-Amz-Signature=abc&X-Amz-Expires=900`)
    await dm(uid, `https://fly.storage.tigris.dev/${bucketFor("chat")}/${pathStyle}`)
    await dm(uid, `https://${bucketFor("profile")}.fly.storage.tigris.dev/${oldPublic}`)
    const orphan = rawKey(uid, "orphan.jpg")
    for (const k of [virtual, query, pathStyle, oldPublic, orphan]) putChat(k)
    await chatPass()
    expect(deleted).toEqual([orphan])
    expect(await rowsNaming(virtual)).toBe(1)
  })

  it("keeps an upload somebody else's DM names: before SCRUM-426 a message could carry anyone's URL", async () => {
    const owner = await sender()
    const other = await sender()
    const key = rawKey(owner, "shared.jpg")
    await dm(other, `${privateHost}/${key}`)
    putChat(key)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an upload a room message's metadata names, under mediaUrl or any other field", async () => {
    const uid = await sender()
    const [media, elsewhere] = [rawKey(uid, "room.jpg"), rawKey(uid, "nested.jpg")]
    await roomMessage(uid, { mediaUrl: `${privateHost}/${media}` })
    await roomMessage(uid, { attachment: { url: `${privateHost}/${elsewhere}` } })
    putChat(media)
    putChat(elsewhere)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an upload a Lobby post names", async () => {
    const uid = await sender()
    const key = rawKey(uid, "lobby.jpg")
    const eventId = await makeEvent(uid)
    chatEvents.push(eventId)
    await db.board_posts.create({ data: { event_id: eventId, author_id: uid, kind: "chat", body: "Look", photo_url: `${privateHost}/${key}`, photo_status: "pending" } })
    putChat(key)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an image a report holds past its author's account (a bare key in retained_report_media)", async () => {
    const uid = await sender()
    const key = rawKey(uid, "held.jpg")
    await db.retained_report_media.create({
      data: { user_id: uid, object_key: key, message_id: "00000000-0000-4000-8000-000000000001", message_type: "private", account_deleted_at: OLD, erase_by: new Date(NOW.getTime() + ORPHAN_GRACE_MS) },
    })
    putChat(key)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an image a sexual image hold names in its audit row", async () => {
    const uid = await sender()
    const key = rawKey(uid, "hold.jpg")
    const row = await db.audit_logs.create({ data: { action: "moderation.sexual_image_hold", resource: "user", resource_id: uid, details: { objectKey: key, path: "lobby", category: "sexual" } }, select: { id: true } })
    auditIds.push(row.id)
    putChat(key)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an upload a reference names percent-encoded", async () => {
    const uid = await sender()
    const key = rawKey(uid, "encoded.jpg")
    await dm(uid, `${privateHost}/${encodeURIComponent(key)}`)
    putChat(key)
    await chatPass()
    expect(deleted).toEqual([])
  })

  it("keeps an upload younger than the grace window: a send can still come", async () => {
    const uid = await sender()
    const young = rawKey(uid, "young.jpg")
    putChat(young, new Date(NOW.getTime() - 60 * 60 * 1000))
    expect(await chatPass()).toMatchObject({ judged: 0, deleted: 0 })
    expect(chatBucket.has(young)).toBe(true)
  })

  it("never touches a sealed copy, new or legacy: unsent ones are discardSealedChatMedia's", async () => {
    const uid = await sender()
    const sealed = "chat/sealed/0b4a7c9e-1d2f-4a3b-8c5d-6e7f8a9b0c1d"
    const legacy = `chat/${uid}/1790641297767-cfg6ta-sealed`
    putChat(sealed)
    putChat(legacy)
    expect(await chatPass()).toMatchObject({ judged: 0, deleted: 0 })
    expect(deleted).toEqual([])
  })

  it("keeps a key whose owner is not a user of this database: the bucket may not be this database's", async () => {
    const stranger = "cmnotauserhere00000000000"
    putChat(rawKey(stranger))
    const error = jest.spyOn(logger, "error")
    const result = await chatPass()
    expect(result).toMatchObject({ judged: 1, orphans: 0, deleted: 0 })
    expect(chatBucket.has(rawKey(stranger))).toBe(true)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not a user"), expect.objectContaining({ unknown: 1 }))
  })

  it("keeps a key it cannot read exactly: a name outside the upload alphabet, a nested name, a loose file", async () => {
    const uid = await sender()
    for (const k of [`chat/${uid}/a b.jpg`, `chat/${uid}/x/y.jpg`, `chat/${uid}/caf%C3%A9.jpg`, "chat/loose.jpg", `chat/${uid}/`]) putChat(k)
    expect(await chatPass()).toMatchObject({ judged: 0, deleted: 0 })
  })

  it("deletes a large backlog rather than refusing it: an old raw key is an orphan by construction", async () => {
    const uid = await sender()
    const keys = Array.from({ length: SANITY_FLOOR + 10 }, (_, i) => rawKey(uid, `b${i}.jpg`))
    keys.forEach((k) => putChat(k))
    const result = await chatPass()
    expect(result).toMatchObject({ refused: false, orphans: SANITY_FLOOR + 10, deleted: SANITY_FLOOR + 10 })
  })

  it("fails closed when the bucket cannot be listed: nothing deleted, and the scheduler's caller hears it", async () => {
    const uid = await sender()
    putChat(rawKey(uid))
    listFails = true
    await expect(chatPass()).rejects.toThrow("storage down")
    expect(deleted).toEqual([])
  })

  it("fails closed when the references cannot be read: nothing deleted", async () => {
    const uid = await sender()
    putChat(rawKey(uid))
    jest.spyOn(appDb, "$queryRaw").mockRejectedValueOnce(new Error("db down"))
    await expect(chatPass()).rejects.toThrow("db down")
    expect(deleted).toEqual([])
    expect(chatBucket.has(rawKey(uid))).toBe(true)
  })

  it("refuses the pass when a row names chat/ in a form it cannot read: that is a reference it would miss", async () => {
    const uid = await sender()
    const unreadable = `https://media.example/chat/${uid}`
    await dm(uid, unreadable)
    putChat(rawKey(uid))
    const error = jest.spyOn(logger, "error")
    try {
      const result = await chatPass()
      expect(result).toMatchObject({ refused: true, deleted: 0 })
      expect(chatBucket.has(rawKey(uid))).toBe(true)
      expect(error).toHaveBeenCalledWith(expect.stringContaining("refused"), expect.anything())
    } finally {
      await db.private_messages.deleteMany({ where: { media_url: unreadable } })
    }
  })

  it("shares one delete budget with the profile sweep per pass", async () => {
    const uid = await sender()
    const owner = await person()
    const refs = Array.from({ length: MAX_DELETES_PER_PASS * 3 }, (_, i) => `profile/${owner}/ref${i}-sealed`)
    await db.profiles.update({ where: { id: owner }, data: { photos: refs.map(url) } })
    refs.forEach((k) => put(k))
    Array.from({ length: MAX_DELETES_PER_PASS }, (_, i) => put(`profile/${owner}/o${i}-sealed`))
    const chatKeys = Array.from({ length: 5 }, (_, i) => rawKey(uid, `c${i}.jpg`))
    chatKeys.forEach((k) => putChat(k))

    const first = await sweepAllOrphans({ now: NOW, mode: "delete" })
    expect(first.profile.deleted + first.chat.deleted).toBe(MAX_DELETES_PER_PASS)
    expect(first.chat.deleted).toBe(0)
    stopOrphanPhotoSweeper()
    const second = await sweepAllOrphans({ now: NOW, mode: "delete" })
    expect(second.chat.deleted).toBe(5)
  })

  it("keeps its own cursor: a profile pass part-way through its bucket does not move where chat reads", async () => {
    const uid = await sender()
    for (let i = 0; i < 5200; i++) put(`profile/young/${String(i).padStart(5, "0")}`, YOUNG)
    expect(await sweepOrphanPhotos({ now: NOW, mode: "log" })).toMatchObject({ complete: false })
    putChat(rawKey(uid))
    expect(await chatPass("log")).toMatchObject({ listed: 1, complete: true })
  })
})
