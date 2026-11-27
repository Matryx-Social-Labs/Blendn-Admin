/*
 * What closed Lobbies and rooms held, 180 days on (SCRUM-1026, owner decision
 * 6), against real rows. The purge deletes: there is no dry run and no switch
 * (SCRUM-1227, D-029), so every pass here is the one production runs. Removed and reported content is held 180 days from its removal;
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

import { MESSAGE_BATCH, purgeClosedLobbies } from "@/lib/lobby-retention"
import { logger } from "@/lib/logger"
import { loopClosure } from "@/lib/loop-closure"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, testId } from "./helpers"

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
  await db.board_seen.deleteMany({ where: { event_id: { in: events } } })
  await db.board_host_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  // A held post's room: board_post_id is ON DELETE RESTRICT, so it goes before its post.
  if (ids.heldPostRoom) await db.chat_groups.deleteMany({ where: { id: ids.heldPostRoom } })
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
/** A closed room of five messages, one of them under an open report (the drive's shape). */
let reportedRoom: { id: string; room: string }
let host = ""
let author = ""
let reporter = ""
let regular = ""
const ids: Record<string, string> = {}
/** What each member row was called in its room, by row id. */
const handles: Record<string, string> = {}
let cameBackBefore = 0
const cameBack = async () => (await loopClosure()).find((s) => s.label === "came back")!.value
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
  // Flags the moderation pipeline raised: pending holds, rejected inside 180 days holds, approved holds nothing.
  const flag = async (status: "pending" | "approved" | "rejected", reviewedDaysAgo: number | null) => {
    const id = await msg(old.room)
    await db.moderation_flags.create({
      data: { message_id: id, chat_group_id: old.room, user_id: author, source: "auto_text", status, categories: {}, confidence: 0.9, reviewed_at: reviewedDaysAgo === null ? null : ago(reviewedDaysAgo), created_at: ago(190) },
    })
    return id
  }
  ids.flagPending = await flag("pending", null)
  ids.flagRejectedRecently = await flag("rejected", 10)
  ids.flagApproved = await flag("approved", 10)
  reportedRoom = await endedEvent(182, host)
  for (let i = 0; i < 4; i++) await msg(reportedRoom.room)
  ids.underOpenReport = await msg(reportedRoom.room)
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: ids.underOpenReport, message_type: "group", reason: "harassment" } })

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
  // A post whose own room holds a message under an open report: the room's delete would cascade to that message.
  ids.postHeldByRoom = await post(old.id)
  ids.heldPostRoom = (await db.chat_groups.create({ data: { kind: "board_post", board_post_id: ids.postHeldByRoom, name: "Ride", status: "archived" }, select: { id: true } })).id
  ids.heldPostRoomMessage = await msg(ids.heldPostRoom)
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: ids.heldPostRoomMessage, message_type: "group", reason: "harassment" } })
  ids.postHiddenRecently = await post(old.id, { moderation_status: "hidden", deleted_at: ago(5) })

  await db.board_host_posts.create({ data: { event_id: old.id, body: "Doors at 6" } })
  await db.board_host_posts.create({ data: { event_id: recent.id, body: "Doors at 7" } })
  await db.board_alert_preferences.create({ data: { user_id: author, event_id: old.id, replies: true } })
  await db.board_alert_preferences.create({ data: { user_id: author, event_id: recent.id, replies: true } })
  await db.board_seen.create({ data: { user_id: author, event_id: old.id, seen_at: ago(200) } })
  await db.board_seen.create({ data: { user_id: author, event_id: recent.id, seen_at: ago(30) } })

  /*
   * Who was in the rooms, by the names the rooms gave them: the author, whose
   * held messages are still in the old room; the reporter, who never wrote
   * there; and a regular who came to both nights ("came back").
   */
  regular = await makeUser(testId("ret-regular"))
  users.push(regular)
  await onboard(regular)
  const member = async (key: string, room: string, user_id: string) => {
    const anonymous_name = testId(key)
    handles[key] = (await db.chat_group_members.create({ data: { chat_group_id: room, user_id, anonymous_name, status: "left" }, select: { id: true } })).id
    handles[`${key}:name`] = anonymous_name
  }
  await member("oldAuthor", old.room, author)
  await member("oldReader", old.room, reporter)
  await member("oldRegular", old.room, regular)
  await member("recentRegular", recent.room, regular)
  for (const event of [old.id, recent.id]) {
    const { end_time } = await db.events.findUniqueOrThrow({ where: { id: event }, select: { end_time: true } })
    await db.event_rsvps.create({ data: { event_id: event, user_id: regular } })
    await db.event_check_ins.create({
      data: { event_id: event, occurrence_id: await occurrenceOf(event), user_id: regular, status: "checked_out", check_in_time: new Date(end_time.getTime() - 2 * 3_600_000), check_out_time: end_time },
    })
  }
  cameBackBefore = await cameBack()
})

const nameOf = async (key: string) => (await db.chat_group_members.findUnique({ where: { id: handles[key] }, select: { anonymous_name: true } }))?.anonymous_name

const exists = {
  message: async (id: string) => (await db.chat_messages.count({ where: { id } })) === 1,
  post: async (id: string) => (await db.board_posts.count({ where: { id } })) === 1,
}

describe("the purge", () => {
  beforeAll(async () => {
    // The pass as the sweeper calls it: no mode, nothing in the environment.
    await purgeClosedLobbies()
    // A post whose room still had messages goes on the pass after them.
    await purgeClosedLobbies()
  })

  it("hard-deletes the room's messages past their time: plain, the author's own deletes, and removals older than 180 days", async () => {
    for (const id of [ids.plain, ids.ownDelete, ids.removedLongAgo, ids.reportedDismissed, ids.postRoomMessage]) expect(await exists.message(id)).toBe(false)
  })

  it("holds a message under a pending flag or one rejected within 180 days, and takes one whose flag was approved", async () => {
    for (const id of [ids.flagPending, ids.flagRejectedRecently]) expect(await exists.message(id)).toBe(true)
    expect(await exists.message(ids.flagApproved)).toBe(false)
  })

  it("keeps a post, its room and the room's message while that message is under an open report", async () => {
    expect(await exists.post(ids.postHeldByRoom)).toBe(true)
    expect(await db.chat_groups.count({ where: { id: ids.heldPostRoom } })).toBe(1)
    expect(await exists.message(ids.heldPostRoomMessage)).toBe(true)
  })

  it("holds removed and reported messages 180 days from their removal, or until a pending report is decided", async () => {
    for (const id of [ids.removedRecently, ids.hiddenByPipeline, ids.reportedPending]) expect(await exists.message(id)).toBe(true)
  })

  it("keeps only the message under an open report in a closed room, and the room with it", async () => {
    const left = await db.chat_messages.findMany({ where: { chat_group_id: reportedRoom.room }, select: { id: true } })
    expect(left).toEqual([{ id: ids.underOpenReport }])
    expect(await db.chat_groups.count({ where: { id: reportedRoom.room } })).toBe(1)
  })

  it("hard-deletes posts with their asks and their photo in storage, and a post's room once it is empty", async () => {
    expect(await exists.post(ids.postWithPhoto)).toBe(false)
    expect(await exists.post(ids.postRemovedLongAgo)).toBe(false)
    expect(await exists.post(ids.postWithRoom)).toBe(false)
    expect(await db.chat_groups.count({ where: { id: ids.postRoom } })).toBe(0)
    expect(mockDeleteFile).toHaveBeenCalledWith(photo.key)
  })

  it("holds a post moderation took down, a rejected photo, and anything reported or with an upheld report on an ask", async () => {
    for (const id of [ids.postRemovedRecently, ids.postHiddenRecently, ids.postPhotoRejected, ids.postReported, ids.postAskReported]) expect(await exists.post(id)).toBe(true)
    expect(mockDeleteFile).not.toHaveBeenCalledWith(heldPhoto.key)
    expect(await db.board_requests.count({ where: { post_id: ids.postAskReported } })).toBe(1)
  })

  it("takes the host's note at 180 days, and the alert switches and seen markers at the close", async () => {
    expect(await db.board_host_posts.count({ where: { event_id: old.id } })).toBe(0)
    expect(await db.board_alert_preferences.count({ where: { event_id: { in: [old.id, recent.id] } } })).toBe(0)
    expect(await db.board_seen.count({ where: { event_id: { in: [old.id, recent.id] } } })).toBe(0)
  })

  it("keeps every member row of a purged room, with its pseudonym blanked", async () => {
    for (const key of ["oldReader", "oldRegular"]) expect(await nameOf(key)).toBeNull()
  })

  it("keeps the pseudonym of a member whose held messages are still in the room", async () => {
    expect(await nameOf("oldAuthor")).toBe(handles["oldAuthor:name"])
  })

  it("leaves 'came back' and the regular's rooms as they were", async () => {
    expect(await cameBack()).toBe(cameBackBefore)
    expect(cameBackBefore).toBeGreaterThanOrEqual(1)
    expect(await db.chat_group_members.count({ where: { user_id: regular } })).toBe(2)
  })

  it("leaves everything inside the window alone (the control)", async () => {
    expect(await exists.message(ids.recentMessage)).toBe(true)
    expect(await exists.post(ids.recentPost)).toBe(true)
    expect(await db.board_host_posts.count({ where: { event_id: recent.id } })).toBe(1)
    expect(await nameOf("recentRegular")).toBe(handles["recentRegular:name"])
    // The event room itself, and the event, are not content: they stay.
    expect(await db.chat_groups.count({ where: { id: old.room } })).toBe(1)
  })

  it("keeps a post's row when its photo could not be deleted, for the next pass", async () => {
    const stuck = sealed()
    const id = (await db.board_posts.create({ data: { event_id: old.id, author_id: author, kind: "chat", body: "x", photo_url: stuck.url, photo_status: "approved", photo_checked_at: ago(183) }, select: { id: true } })).id
    mockDeleteFile.mockRejectedValueOnce(new Error("storage down"))
    const pass = await purgeClosedLobbies()
    expect(pass.kept).toBeGreaterThanOrEqual(1)
    expect(await exists.post(id)).toBe(true)
    await purgeClosedLobbies()
    expect(await exists.post(id)).toBe(false)
  })
})

/*
 * Photos stored before SCRUM-448 (SCRUM-1471): the sender's own `chat/<id>/`
 * key, as a raw upload (before SCRUM-425, on the public bucket's host before
 * SCRUM-427) or a `-sealed` copy (SCRUM-425 to SCRUM-448). The object goes
 * with its message. A URL that names anything else in storage is not the
 * row's to delete: nothing is deleted for it.
 */
describe("the purge, photos stored under the older layout", () => {
  const legacy: Record<string, { id: string; key: string }> = {}
  const refused: Record<string, string> = {}
  let room = ""
  let other = ""
  let warned: unknown[][] = []

  const withPhoto = async (url: string, user_id = author) =>
    (await db.chat_messages.create({ data: { chat_group_id: room, user_id, content: "", metadata: { mediaUrl: url } }, select: { id: true } })).id

  beforeAll(async () => {
    room = (await endedEvent(182, host)).room
    other = await makeUser(testId("ret-other"))
    users.push(other)
    const layouts = {
      rawPrivate: [`chat/${author}/1758000000000-a1b2c3-photo.jpg`, "blendn-media-private.fly.storage.tigris.dev"],
      rawPublic: [`chat/${author}/1758000000000-d4e5f6-IMG_0042.jpg`, "blendn-media.fly.storage.tigris.dev"],
      sealedPerUser: [`chat/${author}/1759100000000-g7h8i9-sealed`, "blendn-media-private.t3.storage.dev"],
    }
    for (const [name, [key, hostName]] of Object.entries(layouts)) legacy[name] = { id: await withPhoto(`https://${hostName}/${key}`), key }

    const bucket = "https://blendn-media-private.fly.storage.tigris.dev"
    const shapes: Record<string, string> = {
      otherHost: `https://images.example.com/chat/${author}/1758000000000-x-photo.jpg`,
      otherBucket: `https://someone-else.fly.storage.tigris.dev/chat/${author}/1758000000000-x-photo.jpg`,
      otherPersonsUpload: `${bucket}/chat/${other}/1758000000000-x-photo.jpg`,
      avatar: `https://blendn-media.fly.storage.tigris.dev/profile/${author}/1758000000000-x-photo.jpg`,
      eventMedia: `https://blendn-media.fly.storage.tigris.dev/events/${author}/1758000000000-x-cover.jpg`,
      traversal: `${bucket}/chat/${author}/%2e%2e/${other}/1758000000000-x-photo.jpg`,
      emptyKey: `${bucket}/chat/${author}/`,
      plainHttp: `http://blendn-media-private.fly.storage.tigris.dev/chat/${author}/1758000000000-x-photo.jpg`,
      notAUrl: `chat/${author}/1758000000000-x-photo.jpg`,
    }
    for (const [name, url] of Object.entries(shapes)) refused[name] = await withPhoto(url)

    mockDeleteFile.mockClear()
    const warn = jest.spyOn(logger, "warn")
    await purgeClosedLobbies()
    warned = warn.mock.calls.filter(([message]) => String(message).startsWith("Lobby purge"))
    warn.mockRestore()
  })

  it.each(["rawPrivate", "rawPublic", "sealedPerUser"])("deletes a %s photo's object with its message", async (name) => {
    expect(mockDeleteFile).toHaveBeenCalledWith(legacy[name].key)
    expect(await exists.message(legacy[name].id)).toBe(false)
  })

  it("deletes nothing in storage for a URL that names anything but the author's own chat/ object", async () => {
    const deleted = mockDeleteFile.mock.calls.map((c) => c[0])
    expect(deleted.sort()).toEqual(Object.values(legacy).map((l) => l.key).sort())
  })

  it("still deletes the row of every refused URL: its text is due like any other", async () => {
    for (const id of Object.values(refused)) expect(await exists.message(id)).toBe(false)
  })

  it("says so in one warning for the pass, by row id and refusal class, never the URL", async () => {
    expect(warned).toHaveLength(1)
    const [, detail] = warned[0] as [string, { count: number; rows: { id: string; why: string }[] }]
    expect(detail.count).toBe(Object.keys(refused).length)
    expect(detail.rows).toHaveLength(5)
    for (const row of detail.rows) expect(Object.values(refused)).toContain(row.id)
    const text = JSON.stringify(warned)
    for (const fragment of ["http", "example.com", "chat/", "profile/", "events/", "photo.jpg", other]) expect(text).not.toContain(fragment)
  })

  it("names the refusal class of each shape", async () => {
    const { chatMediaRefusal } = jest.requireActual<typeof import("@/lib/tigris")>("@/lib/tigris")
    const bucket = "https://blendn-media-private.fly.storage.tigris.dev"
    expect(chatMediaRefusal(`https://images.example.com/chat/${author}/1-x-a.jpg`, author)).toBe("other host")
    expect(chatMediaRefusal(`https://someone-else.fly.storage.tigris.dev/chat/${author}/1-x-a.jpg`, author)).toBe("other host")
    expect(chatMediaRefusal(`http://blendn-media-private.fly.storage.tigris.dev/chat/${author}/1-x-a.jpg`, author)).toBe("other host")
    expect(chatMediaRefusal(`chat/${author}/1-x-a.jpg`, author)).toBe("other host")
    expect(chatMediaRefusal(`${bucket}/chat/${other}/1-x-a.jpg`, author)).toBe("not the author's prefix")
    expect(chatMediaRefusal(`https://blendn-media.fly.storage.tigris.dev/profile/${author}/1-x-a.jpg`, author)).toBe("another prefix")
    expect(chatMediaRefusal(`${bucket}/chat/${author}/%2e%2e/${other}/1-x-a.jpg`, author)).toBe("traversal")
    expect(chatMediaRefusal(`${bucket}/chat/${author}/../${other}/1-x-a.jpg`, author)).toBe("traversal")
    expect(chatMediaRefusal(`${bucket}/chat/${author}/`, author)).toBe("empty")
  })

  it("keeps the row of an owned object whose delete failed, and takes both on the next pass", async () => {
    const key = `chat/${author}/1758000000000-j1k2l3-stuck.jpg`
    const id = await withPhoto(`https://blendn-media-private.fly.storage.tigris.dev/${key}`)
    mockDeleteFile.mockRejectedValueOnce(new Error("storage down"))
    const pass = await purgeClosedLobbies()
    expect(pass.kept).toBe(1)
    expect(await exists.message(id)).toBe(true)
    await purgeClosedLobbies()
    expect(mockDeleteFile).toHaveBeenLastCalledWith(key)
    expect(await exists.message(id)).toBe(false)
  })

  it("drains more than a batch of refused URLs and reaches the photo behind them", async () => {
    const pile = MESSAGE_BATCH + 100
    await db.chat_messages.createMany({
      data: Array.from({ length: pile }, (_, i) => ({ chat_group_id: room, user_id: author, content: "", metadata: { mediaUrl: `https://gifs.example.com/${i}.gif` } })),
    })
    // Written after the pile, so a select that keeps re-reading the pile never gets to it.
    const key = `chat/${author}/1758000000000-m4n5o6-last.jpg`
    const id = await withPhoto(`https://blendn-media-private.fly.storage.tigris.dev/${key}`)
    for (let i = 0; i < 4 && (await exists.message(id)); i++) await purgeClosedLobbies()
    expect(await exists.message(id)).toBe(false)
    expect(mockDeleteFile).toHaveBeenCalledWith(key)
    expect(await db.chat_messages.count({ where: { chat_group_id: room } })).toBe(0)
  })
})
