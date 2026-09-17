import { NextRequest } from "next/server"
import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * Suspending an organisation means something (SCRUM-8).
 *
 * It used to change a badge: `actorFor` never read org status and every
 * published event stayed listed to every phone. Now the org's published events
 * flip to `draft` (remembered), so every attendee surface goes dark on the
 * filter it already has; the membership stops loading, so every dashboard door
 * closes; the room closes; people who were going are told once. Reinstating
 * flips back only what the suspension hid. Real actions, real routes, real rows.
 */
process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn().mockResolvedValue(null), userLimit: jest.fn() }))
// The push transport is mocked; the `notifications` rows are real.
jest.mock("@/lib/push-notifications", () => {
  const actual = jest.requireActual("@/lib/push-notifications")
  return { ...actual, notifyEventUpdate: jest.fn(actual.notifyEventUpdate) }
})

import { signAccessToken } from "@/lib/mobile-auth"
import { setOrganisationStatus } from "@/lib/onboarding-actions"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions } from "@/lib/rbac"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { canJoinChat, canJoinEvent, canJoinEventRoom } from "@/lib/socket-auth"
import { chatWindowState } from "@/lib/chat-window"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const searchRoute = require("@/app/api/mobile/events/search/route") as typeof import("@/app/api/mobile/events/search/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dashboardSearch = require("@/app/api/search/route") as typeof import("@/app/api/search/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

const authed = (url: string, token: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const params = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

async function fixture() {
  const admin = await makeUser("os-admin", "app_admin")
  const host = await makeUser("os-host", "organizer")
  const stranger = await makeUser("os-stranger")
  users.push(admin, host, stranger)
  const org = await db.organisations.create({ data: { display_name: testId("Suspect Org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })

  // Two published events of the org (one upcoming with an RSVP, one live with
  // someone in the room), one the host created before organisations existed,
  // one cancelled by an admin.
  const upcoming = await makeEvent(host)
  const live = await makeEvent(host)
  const legacy = await makeEvent(host)
  const cancelled = await makeEvent(host)
  events.push(upcoming, live, legacy, cancelled)
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.events.update({ where: { id: upcoming }, data: { organizer_org_id: org.id, start_time: soon, end_time: new Date(soon.getTime() + 3600_000), title: "Hidden Sundowner" } })
  await db.events.update({ where: { id: live }, data: { organizer_org_id: org.id } })
  await db.events.update({ where: { id: cancelled }, data: { organizer_org_id: org.id, status: "cancelled" } })
  await db.event_rsvps.create({ data: { event_id: upcoming, user_id: stranger, status: "going" } })
  // Went to the live one too — the room they are in is about to close.
  await db.event_rsvps.create({ data: { event_id: live, user_id: stranger, status: "going" } })
  // The stranger is in the live room.
  await db.event_check_ins.create({ data: { event_id: live, user_id: stranger, occurrence_id: await occurrenceOf(live), check_in_time: new Date(), status: "checked_in" } })
  const group = await db.chat_groups.create({ data: { event_id: live, name: "room", status: "active" } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: stranger, status: "active", anonymous_name: "Quiet Heron" } })

  const strangerEmail = (await db.user.findUniqueOrThrow({ where: { id: stranger }, select: { email: true } })).email
  return { admin, host, stranger, org, upcoming, live, legacy, cancelled, group, token: signAccessToken(stranger, strangerEmail) }
}

// The feed is served from a 30 s in-process cache keyed on the query; a
// different `limit` each call is a different key. On staging, wait 30 s.
let feedCalls = 0
const listedIds = async (token: string) => {
  const res = await listRoute.GET(new NextRequest(`http://localhost/api/mobile/events?includePast=true&limit=${100 - feedCalls++}`, { headers: { authorization: `Bearer ${token}` } }))
  const json = await res.json()
  return new Set(((json.data?.events ?? json.data ?? []) as { id: string }[]).map((e) => e.id))
}
const searchedIds = async (token: string, q: string) => {
  const res = await searchRoute.GET(new NextRequest(`http://localhost/api/mobile/events/search?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${token}` } }))
  const json = await res.json()
  return new Set(((json.data?.events ?? json.data?.results ?? json.data ?? []) as { id: string }[]).map((e) => e.id))
}

describe("suspending an organisation", () => {
  it("hides its published events everywhere, closes its members' doors and its rooms, tells the people going, and reinstating undoes exactly that", async () => {
    const f = await fixture()
    session = { user: { id: f.admin, role: "app_admin" } }

    // Before: the stranger sees all three published events and is in the room.
    expect(await listedIds(f.token)).toEqual(expect.objectContaining(new Set([f.upcoming, f.live, f.legacy])))
    expect((await eventRoute.GET(authed(`/api/mobile/events/${f.upcoming}`, f.token), params(f.upcoming))).status).toBe(200)
    expect(await canJoinChat(f.stranger, f.group.id)).toBe(true)

    await setOrganisationStatus(f.org.id, "suspended", "Repeated safety reports at their events.")

    // The rows say what happened and remember what was.
    const org = await db.organisations.findUniqueOrThrow({ where: { id: f.org.id } })
    expect(org.status).toBe("suspended")
    expect(org.suspension_reason).toBe("Repeated safety reports at their events.")
    expect(org.suspended_at).not.toBeNull()
    const rows = await db.events.findMany({ where: { id: { in: [f.upcoming, f.live, f.legacy, f.cancelled] } }, select: { id: true, status: true, pre_suspension_status: true } })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId[f.upcoming]).toMatchObject({ status: "draft", pre_suspension_status: "published" })
    expect(byId[f.live]).toMatchObject({ status: "draft", pre_suspension_status: "published" })
    expect(byId[f.legacy]).toMatchObject({ status: "published", pre_suspension_status: null }) // no org to suspend
    expect(byId[f.cancelled]).toMatchObject({ status: "cancelled", pre_suspension_status: null })
    // The RSVP and the check-in are still there for the reinstatement.
    expect(await db.event_rsvps.count({ where: { event_id: f.upcoming, user_id: f.stranger } })).toBe(1)
    expect(await db.event_check_ins.count({ where: { event_id: f.live, user_id: f.stranger } })).toBe(1)

    // Every attendee surface: the list, the search (raw SQL), the event, the RSVP, the roster, the room.
    const listed = await listedIds(f.token)
    expect(listed.has(f.upcoming)).toBe(false)
    expect(listed.has(f.live)).toBe(false)
    expect(listed.has(f.legacy)).toBe(true)
    expect((await searchedIds(f.token, "Hidden")).has(f.upcoming)).toBe(false)
    expect((await eventRoute.GET(authed(`/api/mobile/events/${f.upcoming}`, f.token), params(f.upcoming))).status).toBe(404)
    expect((await rsvpRoute.POST(authed(`/api/mobile/events/${f.upcoming}/rsvp`, f.token, "POST", { status: "going" }), params(f.upcoming))).status).toBe(404)
    expect((await rosterRoute.GET(authed(`/api/mobile/events/${f.live}/checkins`, f.token), params(f.live))).status).toBe(404)
    expect(await canJoinChat(f.stranger, f.group.id)).toBe(false)
    expect(await canJoinEvent(f.stranger, f.live)).toBe(false)
    expect(await canJoinEventRoom(f.stranger, f.live)).toBe(false)
    expect(chatWindowState({ start_time: null, end_time: new Date(Date.now() + 3600_000), status: "draft" }, { status: "active" })).toEqual({ open: false, reason: "hidden" })

    // The member's doors: no org, no permission, nothing listed — not even the event they created.
    const actor = await actorFor({ id: f.host, role: "organizer" })
    expect(actor.orgIds).toEqual([])
    const upcomingRow = await db.events.findUniqueOrThrow({ where: { id: f.upcoming }, select: { organizer_org_id: true, venue: { select: { owner_org_id: true } } } })
    expect(eventPermissions(actor, upcomingRow)).toEqual({ canEdit: false, canOperate: false })
    const visible = await db.events.findMany({ where: await visibleEventsWhere({ id: f.host, role: "organizer" }), select: { id: true } })
    const visibleIds = new Set(visible.map((e) => e.id))
    expect(visibleIds.has(f.upcoming)).toBe(false)
    expect(visibleIds.has(f.legacy)).toBe(true) // the creator floor keeps a legacy event

    // ⌘K: the host's own search lists nothing of the org either, and — the leak
    // the review found on the way — an organiser at ANOTHER org never sees it.
    // The route spread its scope under a second `OR` (the search terms), which
    // replaced the scope: every organiser's ⌘K listed every event on the platform.
    const other = await makeUser("os-other", "organizer")
    users.push(other)
    const otherOrg = await db.organisations.create({ data: { display_name: testId("Other Org"), status: "verified" } })
    orgs.push(otherOrg.id)
    await db.organisation_members.create({ data: { org_id: otherOrg.id, user_id: other, role: "owner" } })
    const hitsFor = async (userId: string, role: DashboardRole) => {
      session = { user: { id: userId, role } }
      const res = await dashboardSearch.GET(new NextRequest("http://localhost/api/search?q=Hidden"))
      return ((await res.json()).hits as { id: string; type: string }[]).filter((h) => h.type === "event").map((h) => h.id)
    }
    expect(await hitsFor(other, "organizer")).toEqual([])
    expect(await hitsFor(f.host, "organizer")).toEqual([])
    expect(await hitsFor(f.admin, "app_admin")).toContain(f.upcoming)
    session = { user: { id: f.admin, role: "app_admin" } }

    // The person who was going was told once per event not yet over — the
    // upcoming one and the live one; never about anything already finished.
    const notices = await db.notifications.findMany({ where: { user_id: f.stranger, kind: "event_update" }, orderBy: { title: "asc" } })
    expect(notices.map((n) => (n.data as { eventId: string }).eventId).sort()).toEqual([f.upcoming, f.live].sort())
    expect(notices.every((n) => n.body.includes("no longer available"))).toBe(true)

    // Meanwhile an admin cancels one of the hidden events. Reinstatement must not resurrect it.
    await db.events.update({ where: { id: f.live }, data: { status: "cancelled" } })

    await setOrganisationStatus(f.org.id, "verified")

    const after = await db.organisations.findUniqueOrThrow({ where: { id: f.org.id } })
    expect(after).toMatchObject({ status: "verified", suspended_at: null, suspension_reason: null })
    const restored = Object.fromEntries((await db.events.findMany({ where: { id: { in: [f.upcoming, f.live, f.cancelled] } }, select: { id: true, status: true, pre_suspension_status: true } })).map((r) => [r.id, r]))
    expect(restored[f.upcoming]).toMatchObject({ status: "published", pre_suspension_status: null })
    expect(restored[f.live]).toMatchObject({ status: "cancelled", pre_suspension_status: "published" })
    expect(restored[f.cancelled]).toMatchObject({ status: "cancelled" })
    expect((await listedIds(f.token)).has(f.upcoming)).toBe(true)
    expect((await eventRoute.GET(authed(`/api/mobile/events/${f.upcoming}`, f.token), params(f.upcoming))).status).toBe(200)
    expect((await actorFor({ id: f.host, role: "organizer" })).orgIds).toEqual([f.org.id])
    // Nobody is told twice.
    expect(await db.notifications.count({ where: { user_id: f.stranger, kind: "event_update" } })).toBe(2)
  })
})
