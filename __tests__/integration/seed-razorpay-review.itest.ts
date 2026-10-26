import bcrypt from "bcryptjs"

import { attendeeEventAccess } from "@/lib/event-access"
import { realEventsWhere } from "@/lib/event-kind"
import {
  ensureRazorpayReviewAccount,
  removeRazorpayReviewAccount,
  type ReviewWorld,
} from "@/scripts/seed-razorpay-review"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * The Razorpay reviewer's account, written twice, read back from the tables,
 * held out of every attendee read, and torn down. A namespaced world, so the
 * real address on a developer's seeded database is never touched.
 */

const LOCAL = { DATABASE_URL: "postgresql://postgres:postgres@localhost:55433/blendn_test" }
const PASSWORD = "Rzp-Review-Correct-Horse-26"
const tag = testId("rzp")
const world: ReviewWorld = { email: `${tag}@itest.invalid`, orgName: `${tag} org`, eventSlug: `${tag}-event` }
const users: string[] = []
// Every organisation and account the suite made, so their audit rows go too (remove deletes the organisation).
const seen = { orgs: new Set<string>(), users: new Set<string>() }
async function seed() {
  const s = await ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, { production: false })
  seen.orgs.add(s.orgId)
  seen.users.add(s.userId)
  return s
}

afterAll(async () => {
  const org = await db.organisations.findFirst({ where: { display_name: world.orgName }, select: { id: true } })
  const events = await db.events.findMany({ where: { slug: world.eventSlug }, select: { id: true } })
  const me = await db.user.findUnique({ where: { email: world.email }, select: { id: true } })
  await cleanup([...users, ...(me ? [me.id] : [])], events.map((e) => e.id))
  await db.audit_logs.deleteMany({
    where: { OR: [{ org_id: { in: [...seen.orgs] } }, { resource_id: { in: [...seen.users] } }] },
  })
  if (org) {
    await db.organisation_members.deleteMany({ where: { org_id: org.id } })
    await db.organisations.deleteMany({ where: { id: org.id } })
  }
  await closeDb()
})

it("writes one organizer who owns one organisation with one draft event, and a second run changes nothing", async () => {
  const first = await seed()
  const second = await seed()
  expect(second).toEqual(first)

  const user = await db.user.findUniqueOrThrow({ where: { email: world.email } })
  expect(user.role).toBe("organizer")
  expect(user.emailVerified).not.toBeNull()
  expect(await bcrypt.compare(PASSWORD, user.password ?? "")).toBe(true)

  expect(await db.organisations.count({ where: { display_name: world.orgName } })).toBe(1)
  const members = await db.organisation_members.findMany({ where: { org_id: first.orgId } })
  expect(members.map((m) => [m.user_id, m.role])).toEqual([[first.userId, "owner"]])

  const events = await db.events.findMany({ where: { slug: world.eventSlug } })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ status: "draft", visibility: "private", organizer_org_id: first.orgId, venue_id: null })
  expect(await db.event_occurrences.count({ where: { event_id: first.eventId } })).toBeGreaterThan(0)

  expect(await db.audit_logs.count({ where: { org_id: first.orgId, action: "razorpay_review.seeded" } })).toBe(2)
})

it("puts back a role somebody changed, and never makes an admin", async () => {
  await db.user.update({ where: { email: world.email }, data: { role: "app_admin", suspended_at: new Date() } })
  await seed()
  const user = await db.user.findUniqueOrThrow({ where: { email: world.email } })
  expect(user.role).toBe("organizer")
  expect(user.suspended_at).toBeNull()
})

it("keeps the demo event out of every attendee read", async () => {
  const { eventId } = await seed()
  const attendee = await makeUser("rzp_attendee")
  users.push(attendee)

  expect(await attendeeEventAccess(attendee, eventId, "view")).toMatchObject({ kind: "not_found" })
  // The shape of the feed and search's base filter (app/api/mobile/events/route.ts).
  const listed = await db.events.count({
    where: { id: eventId, ...realEventsWhere, status: "published", deleted_at: null },
  })
  expect(listed).toBe(0)
})

it("refuses an organisation of that name with somebody else in it", async () => {
  const stranger = await makeUser("rzp_stranger", "organizer")
  users.push(stranger)
  const org = await db.organisations.findFirstOrThrow({ where: { display_name: world.orgName } })
  await db.organisation_members.create({ data: { org_id: org.id, user_id: stranger, role: "staff" } })
  await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, { production: false })).rejects.toThrow(/other member/)
  await expect(removeRazorpayReviewAccount(db, world, LOCAL, { production: false })).rejects.toThrow(/other members/)
  await db.organisation_members.deleteMany({ where: { user_id: stranger } })
})

it("--remove takes it all down: event and organisation gone, account closed", async () => {
  const { userId, orgId } = await seed()
  const removed = await removeRazorpayReviewAccount(db, world, LOCAL, { production: false })
  expect(removed).toMatchObject({ userId, orgId, eventsDeleted: 1, orgDeleted: true, billingRowsKept: 0 })

  expect(await db.events.count({ where: { slug: world.eventSlug } })).toBe(0)
  expect(await db.organisations.count({ where: { id: orgId } })).toBe(0)
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
  expect(user.deletedAt).not.toBeNull()
  expect(user.password).toBeNull()
  expect(await db.audit_logs.count({ where: { action: "razorpay_review.removed", resource_id: userId } })).toBe(1)
})
