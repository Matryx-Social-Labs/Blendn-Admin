import bcrypt from "bcryptjs"

import { attendeeEventAccess } from "@/lib/event-access"
import { realEventsWhere } from "@/lib/event-kind"
import { accountBlockReason } from "@/lib/mobile-auth"
import { isRazorpayReviewOrg, reviewOrgRefusal, REVIEW_ORG_REFUSAL } from "@/lib/review-demo-org"
import {
  ensureRazorpayReviewAccount,
  removeRazorpayReviewAccount,
  type ReviewWorld,
} from "@/scripts/seed-razorpay-review"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * The Razorpay reviewer's account: written twice, read back from the tables,
 * held out of every attendee read and every publishing door, never laid over
 * an account it did not make, and taken down whatever the reviewer did to it.
 * Namespaced worlds, so the real address on a developer's database is never
 * touched.
 */

const LOCAL = { DATABASE_URL: "postgresql://postgres:postgres@localhost:55433/blendn_test" }
const LOCAL_FLAGS = { production: false }
const PASSWORD = "Rzp-Review-Correct-Horse-26"
const tags: string[] = []
const users: string[] = []
const orgs = new Set<string>()

function worldFor(label: string): ReviewWorld {
  const tag = testId(label)
  tags.push(tag)
  return { email: `${tag}@itest.invalid`, orgName: `${tag} org` }
}

async function seed(world: ReviewWorld) {
  const s = await ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)
  orgs.add(s.orgId)
  users.push(s.userId)
  return s
}

afterAll(async () => {
  const orgIds = [...orgs]
  const events = await db.events.findMany({ where: { organizer_org_id: { in: orgIds } }, select: { id: true } })
  const eventIds = events.map((e) => e.id)
  await db.entitlements.deleteMany({ where: { event_id: { in: eventIds } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: eventIds } } })
  await db.venues.deleteMany({ where: { created_by_org_id: { in: orgIds } } })
  const tagged = await db.user.findMany({ where: { OR: tags.map((t) => ({ email: { startsWith: t } })) }, select: { id: true } })
  await cleanup([...new Set([...users, ...tagged.map((u) => u.id)])], eventIds)
  await db.audit_logs.deleteMany({ where: { OR: [{ org_id: { in: orgIds } }, { resource_id: { in: orgIds } }] } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgIds } } })
  await db.organisations.deleteMany({ where: { id: { in: orgIds } } })
  await closeDb()
})

describe("apply", () => {
  const world = worldFor("rzp_apply")

  it("writes one organizer who owns one organisation with one draft event, and a second run makes nothing new", async () => {
    const first = await seed(world)
    const second = await seed(world)
    expect(second).toEqual(first)

    const user = await db.user.findUniqueOrThrow({ where: { email: world.email } })
    expect(user.role).toBe("organizer")
    expect(user.emailVerified).not.toBeNull()
    expect(await bcrypt.compare(PASSWORD, user.password ?? "")).toBe(true)

    const members = await db.organisation_members.findMany({ where: { user_id: first.userId } })
    expect(members.map((m) => [m.org_id, m.role])).toEqual([[first.orgId, "owner"]])

    const events = await db.events.findMany({ where: { organizer_org_id: first.orgId } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: first.eventId, status: "draft", visibility: "private", venue_id: null })
    expect(await db.event_occurrences.count({ where: { event_id: first.eventId } })).toBeGreaterThan(0)
  })

  it("finds its event by id, not slug: a renamed event is kept, not duplicated", async () => {
    const { eventId, orgId } = await seed(world)
    await db.events.update({ where: { id: eventId }, data: { slug: `${tags[0]}-renamed`, title: "Renamed by the reviewer" } })
    expect((await seed(world)).eventId).toBe(eventId)
    expect(await db.events.count({ where: { organizer_org_id: orgId, deleted_at: null } })).toBe(1)
  })

  it("keeps the demo event out of every attendee read, and the account out of the app", async () => {
    const { eventId, userId } = await seed(world)
    const attendee = await makeUser("rzp_attendee")
    users.push(attendee)
    expect(await attendeeEventAccess(attendee, eventId, "view")).toMatchObject({ kind: "not_found" })
    // The feed's and search's base filter (app/api/mobile/events/route.ts).
    expect(await db.events.count({ where: { id: eventId, ...realEventsWhere, status: "published", deleted_at: null } })).toBe(0)
    // Mobile sign-in, Google and Apple all ask this; "staff" is refused with "sign in at the dashboard".
    expect(accountBlockReason(await db.user.findUniqueOrThrow({ where: { id: userId } }))).toBe("staff")
  })

  it("marks the organisation for the server's publish, venue and invite refusals, and no other", async () => {
    const { orgId } = await seed(world)
    expect(await isRazorpayReviewOrg(orgId)).toBe(true)
    expect(await reviewOrgRefusal(orgId, { publish: true })).toBe(REVIEW_ORG_REFUSAL)
    expect(await reviewOrgRefusal(orgId, { venue: true })).toBe(REVIEW_ORG_REFUSAL)
    expect(await reviewOrgRefusal(orgId, {})).toBeNull()
    const other = await db.organisations.create({ data: { display_name: `${tags[0]} other`, kind: "company" } })
    orgs.add(other.id)
    expect(await isRazorpayReviewOrg(other.id)).toBe(false)
  })
})

describe("refuses what it did not make", () => {
  it("an account somebody else has at the address: nothing written, password and role untouched", async () => {
    const world = worldFor("rzp_taken")
    const owner = await db.user.create({
      data: { email: world.email, name: "Somebody", role: "app_admin", password: await bcrypt.hash("theirs-not-ours-1", 4) },
    })
    users.push(owner.id)
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/did not create/)
    await expect(removeRazorpayReviewAccount(db, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/did not create/)
    const after = await db.user.findUniqueOrThrow({ where: { id: owner.id } })
    expect(after.role).toBe("app_admin")
    expect(await bcrypt.compare("theirs-not-ours-1", after.password ?? "")).toBe(true)
    expect(after.deletedAt).toBeNull()
    expect(await db.organisations.count({ where: { display_name: world.orgName } })).toBe(0)
  })

  it("a role an admin changed: refused, not put back", async () => {
    const world = worldFor("rzp_role")
    const { userId } = await seed(world)
    await db.user.update({ where: { id: userId }, data: { role: "app_admin" } })
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/role app_admin/)
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).role).toBe("app_admin")
  })

  it("an admin's suspension: refused, not lifted", async () => {
    const world = worldFor("rzp_susp")
    const { userId } = await seed(world)
    await db.user.update({ where: { id: userId }, data: { suspended_at: new Date(), suspension_reason: "Abuse report" } })
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/does not undo moderation/)
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).suspended_at).not.toBeNull()
  })

  it("a user in another organisation, or an organisation with another member", async () => {
    const world = worldFor("rzp_member")
    const { userId, orgId } = await seed(world)
    const elsewhere = await db.organisations.create({ data: { display_name: `${tags.at(-1)} elsewhere`, kind: "company" } })
    orgs.add(elsewhere.id)
    await db.organisation_members.create({ data: { org_id: elsewhere.id, user_id: userId, role: "staff" } })
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/other organisation/)
    await db.organisation_members.deleteMany({ where: { org_id: elsewhere.id } })

    const stranger = await makeUser("rzp_stranger", "organizer")
    users.push(stranger)
    await db.organisation_members.create({ data: { org_id: orgId, user_id: stranger, role: "staff" } })
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/other members/)
    await expect(removeRazorpayReviewAccount(db, world, LOCAL, LOCAL_FLAGS)).rejects.toThrow(/other members/)
    await db.organisation_members.deleteMany({ where: { user_id: stranger } })
  })
})

describe("--remove", () => {
  it("takes down every event and venue of the organisation, an Event Pass's event included, and a re-apply brings back only what it made", async () => {
    const world = worldFor("rzp_remove")
    const { userId, orgId, eventId } = await seed(world)
    // What a reviewer might have left: a renamed demo event, a second event published by an admin, a venue, a pass.
    await db.events.update({ where: { id: eventId }, data: { slug: `${tags.at(-1)}-renamed` } })
    const extra = await db.events.create({
      data: {
        slug: `${tags.at(-1)}-extra`,
        title: "Another night",
        description: "x",
        start_time: new Date(Date.now() + 86_400_000),
        end_time: new Date(Date.now() + 90_000_000),
        timezone: "Asia/Kolkata",
        status: "published",
        organizer_id: userId,
        organizer_org_id: orgId,
      },
    })
    const venue = await db.venues.create({ data: { name: `${tags.at(-1)} venue`, created_by_org_id: orgId } })
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "event_pass", event_id: eventId, source: "grant", starts_at: new Date() },
    })

    const removed = await removeRazorpayReviewAccount(db, world, LOCAL, LOCAL_FLAGS)
    expect(removed).toMatchObject({ userId, orgId, eventsDeleted: 2, venuesRetired: 1 })

    const events = await db.events.findMany({ where: { id: { in: [eventId, extra.id] } } })
    expect(events.every((e) => e.deleted_at !== null && e.status === "draft")).toBe(true)
    expect(events.find((e) => e.id === extra.id)?.pre_suspension_status).toBe("published")
    expect(await db.venues.findUniqueOrThrow({ where: { id: venue.id } })).toMatchObject({ status: "archived" })
    expect((await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).status).toBe("suspended")
    const closed = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(closed.deletedAt).not.toBeNull()
    expect(closed.password).toBeNull()

    const back = await seed(world)
    expect(back.userId).toBe(userId)
    expect(back.orgId).toBe(orgId)
    expect(back.eventId).not.toBe(eventId)
    expect(await db.events.count({ where: { organizer_org_id: orgId, deleted_at: null } })).toBe(1)
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).deletedAt).toBeNull()
  })
})
