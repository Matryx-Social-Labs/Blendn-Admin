/*
 * A reported image, for the person who reviews it (SCRUM-955, owner row A-24).
 *
 * The reports screen showed text only, so an image message read "The message no longer exists". It shows the image now,
 * or the date it was erased when the report came after the sender left. And the 180-day purge waits for a report still pending.
 */
const SESSION: { user: { id: string; role: string; signedInAt: number } | null } = { user: null }
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => SESSION }))
const mockDeletePrefix = jest.fn(async (_prefix: string, _keep?: ReadonlySet<string>) => 0)
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  isConfigured: () => true,
  deletePrefix: (p: string, k?: ReadonlySet<string>) => mockDeletePrefix(p, k),
  deleteFile: jest.fn(async () => undefined),
  readableUrl: async (u: string) => `${u}?signed=1`,
}))

import { getReportQueue } from "@/app/dashboard/moderation/reports/actions"
import { purgeDeletedAccountRecords } from "@/lib/deleted-account-records"
import { closeDb, db, makeEvent, makeUser, testId, cleanup } from "./helpers"

const users: string[] = []
const events: string[] = []
const HOST = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const DAY = 86_400_000

afterAll(async () => {
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
    await left(gone, goneOn, new Date(Date.now() + 100 * DAY))
    await report(kept.id, reporter)
    await report(erased.id, reporter)

    const { rows } = await getReportQueue("pending")

    const rowOf = (name: string) => rows.find((r) => r.subjectId === name)!
    expect(rowOf(stays).image).toEqual({ url: expect.stringMatching(/kept\.jpg\?signed=1$/) })
    expect(rowOf(gone).image).toEqual({ erasedOn: goneOn.toISOString() })
  })
})

describe("the 180-day purge", () => {
  it("keeps a pending report's image and the record, and goes once it is decided", async () => {
    const [reporter, sender] = [await person("ri-rep2"), await person("ri-sender")]
    const message = await imageIn(sender, "held")
    const reported = await report(message.id, reporter, new Date(Date.now() - 200 * DAY))
    await left(sender, new Date(Date.now() - 181 * DAY), new Date(Date.now() - DAY))
    const key = `chat/${sender}/1790641297767-abc123-held.jpg`

    await purgeDeletedAccountRecords()
    expect(await db.deleted_account_records.count({ where: { user_id: sender } })).toBe(1)
    const keep = mockDeletePrefix.mock.calls.find(([p]) => p === `chat/${sender}/`)?.[1]
    expect(keep?.has(key)).toBe(true)

    await db.message_reports.update({ where: { id: reported.id }, data: { status: "reviewed" } })
    await purgeDeletedAccountRecords()
    expect(await db.deleted_account_records.count({ where: { user_id: sender } })).toBe(0)
  })
})
