/*
 * What closed Lobbies and rooms held, 180 days on (SCRUM-1026, owner decision
 * 6): a dry run that counts and deletes nothing, then the real purge, against
 * real rows. Removed and reported content is held 180 days from its removal;
 * anything younger than the window is not touched at all. Storage is the one
 * fake: the purge's deletes are recorded, not sent.
 */
const mockDeleteFile = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  isConfigured: () => true,
  deleteFile: (...a: unknown[]) => mockDeleteFile(...a),
}))

import { randomUUID } from "crypto"

import { purgeClosedLobbies, purgeModeFromEnv } from "@/lib/lobby-retention"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const DAY = 86_400_000
const users: string[] = []
const events: string[] = []
const sealed = () => {
  const key = `chat/sealed/${randomUUID()}`
  return { key, url: `https://blendn-media-private.fly.storage.tigris.dev/${key}` }
}

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.board_alert_preferences.deleteMany({ where: { event_id: { in: events } } })
  await db.board_host_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await closeDb()
})

/** An event that ended `daysAgo` days ago, with its room. */
async function endedEvent(daysAgo: number, host: string) {
  const id = await makeEvent(host)
  events.push(id)
  const end = new Date(Date.now() - daysAgo * DAY)
  await db.events.update({ where: { id }, data: { start_time: new Date(end.getTime() - 3 * 3_600_000), end_time: end } })
  const room = await db.chat_groups.create({ data: { event_id: id, name: "room", status: "archived" }, select: { id: true } })
  return { id, room: room.id }
}

const ago = (days: number) => new Date(Date.now() - days * DAY)

let old: { id: string; room: string }
let recent: { id: string; room: string }
let host = ""
let author = ""
let reporter = ""
const ids: Record<string, string> = {}
const photo = sealed()
const heldPhoto = sealed()

beforeAll(async () => {
  host = await makeUser(testId("ret-host"), "organizer")
  author = await makeUser(testId("ret-author"))
  reporter = await makeUser(testId("ret-reporter"))
  users.push(host, author, reporter)
  // Closed 181 days ago (a day after it ended 182 days ago): past its time.
  old = await endedEvent(182, host)
  // Closed 99 days ago: inside the window, whatever it holds.
  recent = await endedEvent(100, host)

  const msg = async (room: string, extra: object = {}) =>
    (await db.chat_messages.create({ data: { chat_group_id: room, user_id: author, content: "hello", ...extra }, select: { id: true } })).id
  ids.plain = await msg(old.room)
  ids.ownDelete = await msg(old.room, { deleted_at: ago(190), deleted_by: author })
  ids.removedLongAgo = await msg(old.room, { deleted_at: ago(190), deleted_by: host })
  ids.removedRecently = await msg(old.room, { deleted_at: ago(10), deleted_by: host })
  ids.hiddenByPipeline = await msg(old.room, { deleted_at: ago(20), moderation_status: "hidden" })
  ids.reportedPending = await msg(old.room)
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: ids.reportedPending, message_type: "group", reason: "spam" } })
  ids.reportedDismissed = await msg(old.room)
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: ids.reportedDismissed, message_type: "group", reason: "spam", status: "reviewed", reviewed_at: ago(5) } })
  ids.recentMessage = await msg(recent.room)

  const post = async (event: string, extra: object = {}) =>
    (await db.board_posts.create({ data: { event_id: event, author_id: author, kind: "offer", body: "Car", spaces_left: 2, ...extra }, select: { id: true } })).id
  ids.postWithPhoto = await post(old.id, { photo_url: photo.url, photo_status: "approved", photo_checked_at: ago(183) })
  ids.postRemovedRecently = await post(old.id, { moderation_status: "removed", deleted_at: ago(5) })
  ids.postRemovedLongAgo = await post(old.id, { moderation_status: "removed", deleted_at: ago(185) })
  ids.postPhotoRejected = await post(old.id, { photo_url: heldPhoto.url, photo_status: "rejected", photo_checked_at: ago(10) })
  ids.postReported = await post(old.id)
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: ids.postReported, message_type: "board_post", reason: "spam" } })
  ids.postAskReported = await post(old.id)
  const ask = await db.board_requests.create({ data: { event_id: old.id, post_id: ids.postAskReported, from_user_id: reporter, to_user_id: author }, select: { id: true } })
  await db.message_reports.create({ data: { reporter_id: author, message_id: ask.id, message_type: "board_request", reason: "harassment", status: "resolved", reviewed_at: ago(30) } })
  ids.postWithRoom = await post(old.id)
  const postRoom = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: ids.postWithRoom, name: "Car", status: "archived" }, select: { id: true } })
  ids.postRoom = postRoom.id
  ids.postRoomMessage = await msg(postRoom.id)
  ids.recentPost = await post(recent.id)

  await db.board_host_posts.create({ data: { event_id: old.id, body: "Doors at 6" } })
  await db.board_host_posts.create({ data: { event_id: recent.id, body: "Doors at 7" } })
  await db.board_alert_preferences.create({ data: { user_id: author, event_id: old.id, replies: true } })
  await db.board_alert_preferences.create({ data: { user_id: author, event_id: recent.id, replies: true } })
})

const exists = {
  message: async (id: string) => (await db.chat_messages.count({ where: { id } })) === 1,
  post: async (id: string) => (await db.board_posts.count({ where: { id } })) === 1,
}

describe("the mode", () => {
  it("is a dry run unless LOBBY_PURGE says delete", () => {
    expect(purgeModeFromEnv(undefined)).toBe("log")
    expect(purgeModeFromEnv("yes")).toBe("log")
    expect(purgeModeFromEnv(" DELETE ")).toBe("delete")
    expect(purgeModeFromEnv("off")).toBe("off")
  })
})

describe("a dry run", () => {
  it("counts what it would delete and deletes nothing", async () => {
    const pass = await purgeClosedLobbies(new Date(), "log")
    // At least ours: other suites share this database.
    expect(pass.messages).toBeGreaterThanOrEqual(5)
    expect(pass.posts).toBeGreaterThanOrEqual(2)
    expect(pass.hostPosts).toBeGreaterThanOrEqual(1)
    expect(mockDeleteFile).not.toHaveBeenCalled()
    for (const id of [ids.plain, ids.removedLongAgo, ids.postRoomMessage]) expect(await exists.message(id)).toBe(true)
    for (const id of [ids.postWithPhoto, ids.postRemovedLongAgo]) expect(await exists.post(id)).toBe(true)
  })

  it("does nothing at all when off", async () => {
    expect(await purgeClosedLobbies(new Date(), "off")).toMatchObject({ messages: 0, posts: 0, hostPosts: 0 })
  })
})

describe("the purge", () => {
  beforeAll(async () => {
    await purgeClosedLobbies(new Date(), "delete")
    // A post whose room still had messages goes on the pass after them.
    await purgeClosedLobbies(new Date(), "delete")
  })

  it("hard-deletes the room's messages past their time: plain, the author's own deletes, and removals older than 180 days", async () => {
    for (const id of [ids.plain, ids.ownDelete, ids.removedLongAgo, ids.reportedDismissed, ids.postRoomMessage]) expect(await exists.message(id)).toBe(false)
  })

  it("holds removed and reported messages 180 days from their removal, or until a pending report is decided", async () => {
    for (const id of [ids.removedRecently, ids.hiddenByPipeline, ids.reportedPending]) expect(await exists.message(id)).toBe(true)
  })

  it("hard-deletes posts with their asks and their photo in storage, and a post's room once it is empty", async () => {
    expect(await exists.post(ids.postWithPhoto)).toBe(false)
    expect(await exists.post(ids.postRemovedLongAgo)).toBe(false)
    expect(await exists.post(ids.postWithRoom)).toBe(false)
    expect(await db.chat_groups.count({ where: { id: ids.postRoom } })).toBe(0)
    expect(mockDeleteFile).toHaveBeenCalledWith(photo.key)
  })

  it("holds a post moderation took down, a rejected photo, and anything reported or with an upheld report on an ask", async () => {
    for (const id of [ids.postRemovedRecently, ids.postPhotoRejected, ids.postReported, ids.postAskReported]) expect(await exists.post(id)).toBe(true)
    expect(mockDeleteFile).not.toHaveBeenCalledWith(heldPhoto.key)
    expect(await db.board_requests.count({ where: { post_id: ids.postAskReported } })).toBe(1)
  })

  it("takes the host's note at 180 days and the alert switches at the close", async () => {
    expect(await db.board_host_posts.count({ where: { event_id: old.id } })).toBe(0)
    expect(await db.board_alert_preferences.count({ where: { event_id: { in: [old.id, recent.id] } } })).toBe(0)
  })

  it("leaves everything inside the window alone (the control)", async () => {
    expect(await exists.message(ids.recentMessage)).toBe(true)
    expect(await exists.post(ids.recentPost)).toBe(true)
    expect(await db.board_host_posts.count({ where: { event_id: recent.id } })).toBe(1)
    // The event room itself, and the event, are not content: they stay.
    expect(await db.chat_groups.count({ where: { id: old.room } })).toBe(1)
  })

  it("keeps a post's row when its photo could not be deleted, for the next pass", async () => {
    const stuck = sealed()
    const id = (await db.board_posts.create({ data: { event_id: old.id, author_id: author, kind: "chat", body: "x", photo_url: stuck.url, photo_status: "approved", photo_checked_at: ago(183) }, select: { id: true } })).id
    mockDeleteFile.mockRejectedValueOnce(new Error("storage down"))
    const pass = await purgeClosedLobbies(new Date(), "delete")
    expect(pass.kept).toBeGreaterThanOrEqual(1)
    expect(await exists.post(id)).toBe(true)
    await purgeClosedLobbies(new Date(), "delete")
    expect(await exists.post(id)).toBe(false)
  })
})
