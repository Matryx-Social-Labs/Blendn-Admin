/*
 * A reported image, for the person who reviews it (SCRUM-955, owner row A-24).
 *
 * The reports screen showed text only, so an image message read "The message no longer exists". It shows the image now,
 * or the date it was erased when the report came after the sender left. And a report filed before the deletion keeps
 * that one image, on a pointer, past the purge: never the person's other data, and never past the cap.
 */
const SESSION: { user: { id: string; role: string; signedInAt: number } | null } = { user: null }
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => SESSION }))
const mockDeletePrefix = jest.fn(async (_prefix: string, _keep?: ReadonlySet<string>) => 0)
const mockDeleteFile = jest.fn(async (_key: string) => undefined)
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  isConfigured: () => true,
  deletePrefix: (p: string, k?: ReadonlySet<string>) => mockDeletePrefix(p, k),
  deleteFile: (k: string) => mockDeleteFile(k),
  readableUrl: async (u: string) => `${u}?signed=1`,
}))

import { getReportQueue } from "@/app/dashboard/moderation/reports/actions"
import { purgeDeletedAccountRecords } from "@/lib/deleted-account-records"
import { logger } from "@/lib/logger"
import { REPORT_HOLD_DAYS } from "@/lib/retained-media"
import { closeDb, db, makeEvent, makeUser, testId, cleanup } from "./helpers"

const users: string[] = []
const events: string[] = []
const HOST = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const DAY = 86_400_000

afterAll(async () => {
  await db.retained_report_media.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function imageIn(sender: string, name: string) {
  const eventId = await makeEvent(await person("ri-host", "organizer"))
  events.push(eventId)
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  return db.chat_messages.create({
    data: { chat_group_id: room.id, user_id: sender, content: "", type: "image", metadata: { mediaUrl: `${HOST}/chat/${sender}/1790641297767-abc123-${name}.jpg` } },
  })
}
async function person(label: string, role: "attendee" | "organizer" | "app_admin" = "attendee") {
  const id = await makeUser(testId(label), role)
  users.push(id)
  return id
}
const report = (message_id: string, reporter_id: string, created_at = new Date()) =>
  db.message_reports.create({
    data: { message_id, message_type: "group", reporter_id, reason: "harassment", created_at },
  })
const left = (user_id: string, deleted_at: Date, purge_after: Date) =>
  db.deleted_account_records.create({
    data: { user_id, email: `${user_id}@itest.invalid`, account_created_at: new Date("2025-01-01"), deleted_at, sign_up_method: "email", purge_after },
  })

describe("the reports screen", () => {
  it("shows the image, signed; names the erasure when the report came after the sender left", async () => {
    const admin = await person("ri-admin", "app_admin")
    SESSION.user = { id: admin, role: "app_admin", signedInAt: Date.now() }
    const [reporter, stays, gone] = [await person("ri-rep"), await person("ri-stays"), await person("ri-gone")]
    const kept = await imageIn(stays, "kept")
    const erased = await imageIn(gone, "erased")
    const goneOn = new Date(Date.now() - 2 * DAY)
    await db.user.update({ where: { id: gone }, data: { deletedAt: goneOn } })
    await report(kept.id, reporter)
    await report(erased.id, reporter)

    const { rows } = await getReportQueue("pending")

    const rowOf = (name: string) => rows.find((r) => r.subjectId === name)!
    expect(rowOf(stays).image).toEqual({ url: expect.stringMatching(/kept\.jpg\?signed=1$/) })
    expect(rowOf(gone).image).toEqual({ senderLeftOn: goneOn.toISOString() })
  })
})

describe("the 180-day purge and a pending report's image (A-24)", () => {
  const passed = () => new Date(Date.now() - DAY)
  const keyOf = (id: string, name: string) => `chat/${id}/1790641297767-abc123-${name}.jpg`
  async function reportedThenGone(name: string, reportedDaysAgo = 200) {
    const [reporter, sender] = [await person("ri-rep2"), await person("ri-sender")]
    const message = await imageIn(sender, name)
    const reported = await report(message.id, reporter, new Date(Date.now() - reportedDaysAgo * DAY))
    await left(sender, new Date(Date.now() - 181 * DAY), passed())
    return { sender, reported, key: keyOf(sender, name) }
  }

  it("purges the person on schedule, profile media included; only the image waits, on a pointer", async () => {
    const { sender, key } = await reportedThenGone("held")

    await purgeDeletedAccountRecords()

    expect(await db.deleted_account_records.count({ where: { user_id: sender } })).toBe(0)
    expect(mockDeletePrefix).toHaveBeenCalledWith(`profile/${sender}/`, undefined)
    const keep = mockDeletePrefix.mock.calls.find(([p]) => p === `chat/${sender}/`)?.[1]
    expect(keep?.has(key)).toBe(true)
    const [pointer] = await db.retained_report_media.findMany({ where: { user_id: sender } })
    expect(pointer.object_key).toBe(key)
    expect(pointer.erase_by.getTime() - passed().getTime()).toBeCloseTo(REPORT_HOLD_DAYS * DAY, -4)
  })

  it("a report filed after the deletion creates no hold", async () => {
    const { sender } = await reportedThenGone("late", 1)
    await purgeDeletedAccountRecords()
    expect(await db.retained_report_media.count({ where: { user_id: sender } })).toBe(0)
    expect(mockDeletePrefix.mock.calls.find(([p]) => p === `chat/${sender}/`)?.[1]?.size ?? 0).toBe(0)
  })

  it("a later report, or the author's own, does not extend the hold once the first is decided", async () => {
    const { sender, reported, key } = await reportedThenGone("later")
    await purgeDeletedAccountRecords()
    const message = await db.message_reports.findUniqueOrThrow({ where: { id: reported.id }, select: { message_id: true } })
    await report(message.message_id, await person("ri-rep3"))
    await report(message.message_id, sender, new Date(Date.now() - 300 * DAY))
    await db.message_reports.update({ where: { id: reported.id }, data: { status: "reviewed" } })
    mockDeleteFile.mockClear()
    await purgeDeletedAccountRecords()
    expect(mockDeleteFile).toHaveBeenCalledWith(key)
  })

  it("erases the image when the report is decided", async () => {
    const { sender, reported, key } = await reportedThenGone("decided")
    await purgeDeletedAccountRecords()
    mockDeleteFile.mockClear()

    await purgeDeletedAccountRecords()
    expect(mockDeleteFile).not.toHaveBeenCalledWith(key)

    await db.message_reports.update({ where: { id: reported.id }, data: { status: "reviewed" } })
    await purgeDeletedAccountRecords()
    expect(mockDeleteFile).toHaveBeenCalledWith(key)
    expect(await db.retained_report_media.count({ where: { user_id: sender } })).toBe(0)
  })

  it("erases it at the cap whatever is pending, and warns as the cap nears", async () => {
    const { sender, key } = await reportedThenGone("capped")
    await purgeDeletedAccountRecords()
    mockDeleteFile.mockClear()
    const warn = jest.spyOn(logger, "warn")

    await db.retained_report_media.updateMany({ where: { user_id: sender }, data: { erase_by: new Date(Date.now() + DAY) } })
    await purgeDeletedAccountRecords()
    expect(mockDeleteFile).not.toHaveBeenCalledWith(key)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/report.*decided/i), expect.objectContaining({ pointerId: expect.any(String) }))

    await db.retained_report_media.updateMany({ where: { user_id: sender }, data: { erase_by: new Date(Date.now() - 1000) } })
    await purgeDeletedAccountRecords()
    expect(mockDeleteFile).toHaveBeenCalledWith(key)
    expect(await db.retained_report_media.count({ where: { user_id: sender } })).toBe(0)
    warn.mockRestore()
  })
})
