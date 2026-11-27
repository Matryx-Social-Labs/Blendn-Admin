import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { NextRequest } from "next/server"

import { getModerationQueue } from "@/app/dashboard/moderation/actions"
import { GET as roomFeed } from "@/app/api/events/[id]/chat/messages/route"
import { GET as flagQueue } from "@/app/api/events/[id]/chat/moderation/route"
import { buildReport } from "@/lib/reports"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * A hidden line's flag carries `unjudged` until the model has answered
 * (`recordHide`, SCRUM-1474). Every reader that shows a flag's categories —
 * the admin queue's label, the host's flag list and member chips, the
 * moderation export — shows them without it: exactly what a swear-word hide
 * shows with the key absent.
 *
 * The flag is dated 2001 so the admin queue (oldest first) lists it on its
 * first page, whatever else the database holds.
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const AT = new Date("2001-01-01T00:00:00Z")
const MARKED = { unjudged: 0.9, profanity: 0.9 }
const SHOWN = { profanity: 0.9 }

let host = ""
let admin = ""
let ana = ""
let eventId = ""
let flagId = ""

beforeAll(async () => {
  host = await makeUser(testId("fdc-host"), "organizer")
  admin = await makeUser(testId("fdc-admin"), "app_admin")
  ana = await makeUser(testId("fdc-ana"))
  users.push(host, admin, ana)
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId("fdc-org"), status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: host, role: "owner" } })
  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: o.id } })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: host, role: "admin" } })
  // Muted, so the host's feed lists her recent flags.
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: ana, anonymous_name: "Quiet Otter", status: "muted", muted_at: new Date() } })
  const said = await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: ana, content: "tu chutiya hai", moderation_status: "hidden", deleted_at: new Date() }, select: { id: true } })
  const flag = await db.moderation_flags.create({
    data: { message_id: said.id, chat_group_id: group.id, user_id: ana, source: "auto_keyword", confidence: 0.9, categories: MARKED, auto_action: "hidden", created_at: AT },
    select: { id: true },
  })
  flagId = flag.id
})

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

it("stores the flag with the key first, as Postgres orders jsonb keys", async () => {
  const { categories } = await db.moderation_flags.findUniqueOrThrow({ where: { id: flagId }, select: { categories: true } })
  expect(Object.keys(categories as object)).toEqual(["unjudged", "profanity"])
})

it("labels the flag in the admin queue as a swear-word hide", async () => {
  as("app_admin", admin)
  const { rows } = await getModerationQueue("pending")
  expect(rows.find((r) => r.id === flagId)?.category).toBe("profanity")
})

it("shows the host the flag's categories without the key, on the flag list and on the muted member", async () => {
  as("organizer", host)
  const list = await flagQueue(new NextRequest(`http://localhost/api/events/${eventId}/chat/moderation`), { params: Promise.resolve({ id: eventId }) })
  expect(list.status).toBe(200)
  const listWire = await list.text()
  expect(listWire).not.toContain("unjudged")
  const flags = (JSON.parse(listWire) as { data: { flags: { id: string; categories: unknown }[] } }).data.flags
  expect(flags.find((f) => f.id === flagId)?.categories).toEqual(SHOWN)

  const feed = await roomFeed(new Request(`http://localhost/api/events/${eventId}/chat/messages`), { params: Promise.resolve({ id: eventId }) })
  expect(feed.status).toBe(200)
  const feedWire = await feed.text()
  expect(feedWire).not.toContain("unjudged")
  const members = (JSON.parse(feedWire) as { members: { anonymousName: string | null; recentViolations?: { categories: unknown }[] }[] }).members
  expect(members.find((m) => m.anonymousName === "Quiet Otter")?.recentViolations?.[0]?.categories).toEqual(SHOWN)
})

it("leaves the key out of the moderation export", async () => {
  const csv = await buildReport("moderation", "app_admin", admin, { key: "custom", from: new Date(AT.getTime() - 60_000), to: new Date(AT.getTime() + 60_000) })
  expect(csv).toContain("auto_keyword")
  expect(csv).not.toContain("unjudged")
})
