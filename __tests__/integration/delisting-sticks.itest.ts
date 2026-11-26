/*
 * A moderator's delisting sticks (SCRUM-1394).
 *
 * `delist` takes a reported event out of the feed (`visibility: unlisted`).
 * The organizer's editor writes `visibility` too, so without a record of the
 * delisting one save put the event back; and `changed_from` keeps only the
 * last edit, so the reported title and description were gone after two. Now
 * the delist records when and by whom (`delisted_at`, `delisted_by`) and
 * keeps the title and description in its audit row; the one door that edits
 * an existing event (`updateEventTracked`) refuses a visibility change on a
 * delisted event to anybody but an admin, and an admin's move back to public
 * clears the record. Driven through the real report action and the real
 * PATCH handler on a db:migrate database.
 */
let session: { user: { id: string; role: "app_admin" | "organizer" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session ? { ...session, user: { signedInAt: Date.now(), ...session.user } } : null) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({
  emitChatMessageHidden: jest.fn(),
  evictUserSockets: jest.fn(),
  closeRoomSockets: jest.fn(),
  getIO: () => null,
}))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken() {
      return false
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: unknown[]) {
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  }
  return { Expo }
})

import { NextRequest } from "next/server"
import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { duplicateFor } from "@/lib/event-duplicate"
import { refusalText } from "@/lib/refusal"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")

const SENTENCE = "A moderator set this event to Unlisted, so its visibility can’t be changed. Contact support to ask for a review."
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let admin = ""
let secondAdmin = ""
let host = ""
let reporter = ""
let orgId = ""

beforeAll(async () => {
  admin = await makeUser(testId("dl-admin"), "app_admin")
  secondAdmin = await makeUser(testId("dl-admin2"), "app_admin")
  host = await makeUser(testId("dl-host"), "organizer")
  reporter = await makeUser(testId("dl-reporter"))
  users.push(admin, secondAdmin, host, reporter)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("dl-org"), status: "verified" } })
  orgId = org.id
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
})

afterAll(async () => {
  await db.event_reports.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function hostedEvent(title: string, description: string) {
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({ where: { id }, data: { organizer_org_id: orgId, title, description, visibility: "public" } })
  return id
}

async function delist(eventId: string, by: string) {
  const report = await db.event_reports.create({ data: { event_id: eventId, user_id: reporter, reason: "spam" } })
  session = { user: { id: by, role: "app_admin" } }
  await resolveReport("event", report.id, "delist")
  return report.id
}

/** A save as the editor sends it: the form's required fields as they stand, then the change. */
async function patch(eventId: string, as: { id: string; role: "app_admin" | "organizer" }, extra: Record<string, unknown>) {
  const e = await db.events.findUniqueOrThrow({ where: { id: eventId } })
  const body = { title: e.title, description: e.description, start_time: e.start_time, end_time: e.end_time, timezone: e.timezone, ...extra }
  session = { user: as }
  return eventRoute.PATCH(
    new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: eventId }) }
  )
}

// `delisted_by` is @ignore'd in the client, so the read-back is SQL.
async function row(id: string) {
  const [r] = await db.$queryRaw<
    { visibility: string; title: string; description: string; delisted_at: Date | null; delisted_by: string | null }[]
  >`SELECT visibility::text, title, description, delisted_at, delisted_by FROM events WHERE id = ${id}::uuid`
  return r
}

it("a delist records when and by whom, and its audit row keeps the title and description as reported", async () => {
  const eventId = await hostedEvent("Reported title", "Reported description")

  const reportId = await delist(eventId, admin)

  const after = await row(eventId)
  expect(after.visibility).toBe("unlisted")
  expect(after.delisted_at).toBeInstanceOf(Date)
  expect(after.delisted_by).toBe(admin)
  const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "report.delist", resource_id: reportId } })
  expect(audit.details).toMatchObject({ eventId, title: "Reported title", description: "Reported description" })
})

it("the organizer cannot put it back: 403 in words the editor shows, and nothing in the save is written", async () => {
  const eventId = await hostedEvent("Kept title", "Kept description")
  await delist(eventId, admin)
  const before = await row(eventId)

  const res = await patch(eventId, { id: host, role: "organizer" }, { visibility: "public", title: "Sneaked title" })

  expect(res.status).toBe(403)
  expect(await refusalText(res, "Failed to save event")).toBe(SENTENCE)
  expect(await row(eventId)).toEqual(before)
})

it("the organizer's other edits still save, and the delisting stays", async () => {
  const eventId = await hostedEvent("First title", "First description")
  const reportId = await delist(eventId, admin)
  const before = await row(eventId)

  // The editor sends the visibility it shows on every save: unchanged is not a change.
  const res = await patch(eventId, { id: host, role: "organizer" }, { visibility: "unlisted", title: "Edited title", description: "Edited description" })

  expect(res.status).toBe(200)
  const after = await row(eventId)
  expect(after).toMatchObject({ visibility: "unlisted", title: "Edited title", delisted_by: admin })
  expect(after.delisted_at).toEqual(before.delisted_at)
  // The evidence is the audit row, not the event.
  const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "report.delist", resource_id: reportId } })
  expect(audit.details).toMatchObject({ title: "First title", description: "First description" })
})

it("a second delist keeps the first one's time and moderator, and snapshots the text as it is then", async () => {
  const eventId = await hostedEvent("Original", "Original text")
  await delist(eventId, admin)
  const first = await row(eventId)
  await patch(eventId, { id: host, role: "organizer" }, { title: "Renamed", description: "Rewritten" })

  const secondReport = await delist(eventId, secondAdmin)

  const after = await row(eventId)
  expect(after.delisted_at).toEqual(first.delisted_at)
  expect(after.delisted_by).toBe(admin)
  const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "report.delist", resource_id: secondReport } })
  expect(audit.details).toMatchObject({ title: "Renamed", description: "Rewritten" })
})

it("Duplicate offers a delisted event's organizer the plain form, and a listed one the copy", async () => {
  const delisted = await hostedEvent("Delisted night", "x")
  const listed = await hostedEvent("Listed night", "x")
  await delist(delisted, admin)
  const user = { id: host, role: "organizer" as const }

  expect(await duplicateFor(user, delisted)).toBeNull()
  expect(await duplicateFor(user, listed)).not.toBeNull()
})

it("an admin puts it back: public clears both columns, with an audit row", async () => {
  const eventId = await hostedEvent("Relisted", "x")
  await delist(eventId, admin)

  const res = await patch(eventId, { id: secondAdmin, role: "app_admin" }, { visibility: "public" })

  expect(res.status).toBe(200)
  expect(await row(eventId)).toMatchObject({ visibility: "public", delisted_at: null, delisted_by: null })
  expect(await db.audit_logs.count({ where: { action: "event.relist", resource_id: eventId, user_id: secondAdmin } })).toBe(1)
  // Listed again, the organizer's own visibility is theirs once more.
  expect((await patch(eventId, { id: host, role: "organizer" }, { visibility: "unlisted" })).status).toBe(200)
})

it("an admin edit that leaves it unlisted leaves the delisting in place", async () => {
  const eventId = await hostedEvent("Still delisted", "x")
  await delist(eventId, admin)

  const res = await patch(eventId, { id: secondAdmin, role: "app_admin" }, { visibility: "unlisted", title: "Admin fixed a typo" })

  expect(res.status).toBe(200)
  expect(await row(eventId)).toMatchObject({ visibility: "unlisted", delisted_by: admin })
  expect(await db.audit_logs.count({ where: { action: "event.relist", resource_id: eventId } })).toBe(0)
})

it("no answer to the organizer says which moderator delisted it", async () => {
  const eventId = await hostedEvent("Who did it", "x")
  await delist(eventId, admin)
  session = { user: { id: host, role: "organizer" } }

  const saved = await (await patch(eventId, { id: host, role: "organizer" }, { title: "Who did it, edited" })).json()
  const shown = await (await eventRoute.GET(new Request(`http://localhost/api/events/${eventId}`), { params: Promise.resolve({ id: eventId }) })).json()
  const listed = (await (await eventsRoute.GET(new NextRequest("http://localhost/api/events?limit=100"))).json()) as { id: string }[]

  expect(shown.delisted_at).not.toBeNull()
  for (const answer of [saved, shown, listed.find((e) => e.id === eventId)]) {
    expect(answer).toBeDefined()
    expect(JSON.stringify(answer)).not.toContain(admin)
  }
})
