/**
 * Two admins deciding one thing at once (step 18 security review, H1, M1, M2).
 *
 * Every queue read the row, checked it was pending, then wrote. A read is not a
 * lock: approve ∥ decline on one event claim both succeeded, and 8 times in 12
 * the claim said "declined" while the event had been handed over. Each decision
 * now writes `… where status is pending` and refuses on any other count, with
 * its audit row in the same transaction. So here, for each queue, two
 * decisions race through `Promise.allSettled` and the result is checked from
 * the tables: one wins, the other is refused, one audit row, one email, and no
 * state that contradicts the winner.
 *
 * And the words: a decision this queue does not take is refused before anything
 * is written, and a decline or rejection without a ten-character reason too.
 */
const sent: Array<{ to: string; subject: string }> = []
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({
  emitChatMessageHidden: jest.fn(),
  evictUserSockets: jest.fn(),
  closeRoomSockets: jest.fn(),
  getIO: () => null,
}))
jest.mock("@/lib/email", () => ({
  ...jest.requireActual("@/lib/email"),
  emailConfigured: () => true,
  sendEmail: jest.fn(async (m: { to: string; subject: string }) => {
    sent.push({ to: m.to, subject: m.subject })
    return { sent: true }
  }),
}))

import { resolveFlag } from "@/app/dashboard/moderation/actions"
import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { decideCreative } from "@/lib/creative-review-actions"
import { decideEventClaim } from "@/lib/event-claim-actions"
import { approveOnboardingRequest, declineOnboardingRequest } from "@/lib/onboarding-actions"
import { decideSponsorClaim } from "@/lib/sponsor-claim-actions"
import { decideVenueClaim } from "@/lib/venue-claim-actions"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const sponsors: string[] = []
const requests: string[] = []
const venues: string[] = []
let admin = ""

const REASON = "Not yours to run, by the evidence."

beforeAll(async () => {
  admin = await makeUser("race_admin", "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
})

beforeEach(() => {
  sent.length = 0
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: admin } })
  await db.event_claims.deleteMany({ where: { event_id: { in: events } } })
  await db.sponsored_creatives.deleteMany({ where: { message: { event_id: { in: events } } } })
  await db.event_sponsored_messages.deleteMany({ where: { event_id: { in: events } } })
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.venue_claims.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.sponsors.deleteMany({ where: { id: { in: sponsors } } })
  const madeOrgs = await db.organiser_onboarding_requests.findMany({ where: { id: { in: requests } }, select: { org_id: true } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  const allOrgs = [...orgs, ...madeOrgs.flatMap((r) => (r.org_id ? [r.org_id] : []))]
  await db.organisation_domains.deleteMany({ where: { org_id: { in: allOrgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: allOrgs } } })
  await db.organisations.deleteMany({ where: { id: { in: allOrgs } } })
  const madeUsers = await db.user.findMany({ where: { email: { startsWith: "race-app-" } }, select: { id: true } })
  await cleanup([...users, ...madeUsers.map((u) => u.id)], events)
  await closeDb()
})

async function org() {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId("Race Org"), status: "verified" } })
  orgs.push(o.id)
  return o.id
}

/** An event days away, curated by us and unclaimed. */
async function curatedEvent() {
  const id = await makeEvent(admin)
  events.push(id)
  const start = new Date(Date.now() + 3 * 86_400_000)
  await db.events.update({
    where: { id },
    data: { curated_at: new Date(), start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) },
  })
  return id
}

/** The two outcomes of a race: exactly one fulfilled; the rejection a refusal, not a crash. */
async function race(a: () => Promise<unknown>, b: () => Promise<unknown>) {
  const [ra, rb] = await Promise.allSettled([a(), b()])
  const won = [ra, rb].filter((r) => r.status === "fulfilled")
  const lost = [ra, rb].filter((r): r is PromiseRejectedResult => r.status === "rejected")
  expect(won).toHaveLength(1)
  expect(lost).toHaveLength(1)
  expect(String(lost[0].reason?.message)).toMatch(/Someone else decided this|already|Somebody else's claim was approved first/)
  return { firstWon: ra.status === "fulfilled" }
}

const auditCount = (resourceId: string, actionPrefix: string) =>
  db.audit_logs.count({ where: { resource_id: resourceId, action: { startsWith: actionPrefix } } })

describe("an event claim", () => {
  it.each([1, 2, 3, 4])("approve ∥ decline: one decision, the event agrees with it (run %i)", async () => {
    const eventId = await curatedEvent()
    const orgId = await org()
    const claim = await db.event_claims.create({
      data: { event_id: eventId, org_id: orgId, contact_email: `race-${testId("c")}@toit.in`, status: "pending" },
    })

    const { firstWon } = await race(
      () => decideEventClaim(claim.id, "approve"),
      () => decideEventClaim(claim.id, "decline", REASON)
    )

    const after = await db.event_claims.findUniqueOrThrow({ where: { id: claim.id }, select: { status: true } })
    const event = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { organizer_org_id: true, claimed_at: true } })
    if (firstWon) {
      expect(after.status).toBe("approved")
      expect(event).toMatchObject({ organizer_org_id: orgId, claimed_at: expect.any(Date) })
    } else {
      expect(after.status).toBe("declined")
      expect(event).toEqual({ organizer_org_id: null, claimed_at: null })
    }
    expect(await auditCount(claim.id, "event_claim.")).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it("two claims approved at once: one organisation gets the event", async () => {
    const eventId = await curatedEvent()
    const [a, b] = [await org(), await org()]
    const ca = await db.event_claims.create({ data: { event_id: eventId, org_id: a, contact_email: "race-a@toit.in", status: "pending" } })
    const cb = await db.event_claims.create({ data: { event_id: eventId, org_id: b, contact_email: "race-b@toit.in", status: "pending" } })

    const { firstWon } = await race(() => decideEventClaim(ca.id, "approve"), () => decideEventClaim(cb.id, "approve"))

    const event = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { organizer_org_id: true } })
    expect(event.organizer_org_id).toBe(firstWon ? a : b)
    const approved = await db.event_claims.count({ where: { event_id: eventId, status: "approved" } })
    expect(approved).toBe(1)
  })
})

describe("a brand claim", () => {
  it("approve ∥ reject: one decision, the brand agrees with it", async () => {
    const orgId = await org()
    const filer = await makeUser("race_filer", "organizer")
    users.push(filer)
    const brand = await db.sponsors.create({ data: { name: testId("Race Brand"), name_key: testId("racebrand") } })
    sponsors.push(brand.id)
    const claim = await db.sponsor_claims.create({ data: { sponsor_id: brand.id, org_id: orgId, filed_by: filer } })

    const { firstWon } = await race(
      () => decideSponsorClaim(claim.id, "approve"),
      () => decideSponsorClaim(claim.id, "reject", REASON)
    )

    const after = await db.sponsor_claims.findUniqueOrThrow({ where: { id: claim.id }, select: { status: true } })
    const owner = await db.sponsors.findUniqueOrThrow({ where: { id: brand.id }, select: { org_id: true } })
    expect(after.status).toBe(firstWon ? "approved" : "rejected")
    expect(owner.org_id).toBe(firstWon ? orgId : null)
    expect(await auditCount(brand.id, "sponsor.claim.")).toBe(1)
    expect(sent).toHaveLength(1)
  })
})

describe("a sponsored creative", () => {
  it("approve ∥ reject: one review, the campaign agrees with it", async () => {
    const eventId = await curatedEvent()
    const brand = await db.sponsors.create({ data: { name: testId("Race Creative"), name_key: testId("racecreative") } })
    sponsors.push(brand.id)
    const message = await db.event_sponsored_messages.create({ data: { event_id: eventId, sponsor_id: brand.id, content: "Race copy" } })
    const creative = await db.sponsored_creatives.create({ data: { message_id: message.id, content: "Race copy" } })

    const { firstWon } = await race(
      () => decideCreative(creative.id, "approve"),
      () => decideCreative(creative.id, "reject", REASON)
    )

    const c = await db.sponsored_creatives.findUniqueOrThrow({ where: { id: creative.id }, select: { moderation_status: true } })
    const m = await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: message.id }, select: { moderation_status: true } })
    expect(c.moderation_status).toBe(firstWon ? "approved" : "rejected")
    expect(m.moderation_status).toBe(c.moderation_status)
    expect(await auditCount(creative.id, "creative.")).toBe(1)
  })
})

describe("a moderation flag", () => {
  it("keep ∥ remove: one decision, the message agrees with it", async () => {
    const eventId = await curatedEvent()
    const author = await makeUser("race_author")
    users.push(author)
    const group = await db.chat_groups.create({ data: { event_id: eventId, name: testId("race-room"), type: "event" } })
    const message = await db.chat_messages.create({
      data: { chat_group_id: group.id, user_id: author, content: "race message", moderation_status: "hidden", deleted_at: new Date() },
    })
    const flag = await db.moderation_flags.create({
      data: { message_id: message.id, chat_group_id: group.id, user_id: author, source: "auto_text", categories: {}, confidence: 0.9, status: "pending" },
    })

    const { firstWon } = await race(() => resolveFlag(flag.id, "approve"), () => resolveFlag(flag.id, "remove"))

    const f = await db.moderation_flags.findUniqueOrThrow({ where: { id: flag.id }, select: { status: true } })
    const m = await db.chat_messages.findUniqueOrThrow({ where: { id: message.id }, select: { deleted_at: true, moderation_status: true } })
    if (firstWon) {
      expect(f.status).toBe("approved")
      expect(m).toEqual({ deleted_at: null, moderation_status: "clean" })
    } else {
      expect(f.status).toBe("rejected")
      expect(m.deleted_at).not.toBeNull()
    }
    expect(await auditCount(flag.id, "moderation.")).toBe(1)
  })
})

describe("a report", () => {
  it("dismiss ∥ suspend: one decision, the account agrees with it", async () => {
    const reporter = await makeUser("race_reporter")
    const reported = await makeUser("race_reported")
    users.push(reporter, reported)
    const report = await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "harassment", status: "pending" } })

    const { firstWon } = await race(
      () => resolveReport("user", report.id, "dismiss"),
      () => resolveReport("user", report.id, "suspend")
    )

    const r = await db.user_reports.findUniqueOrThrow({ where: { id: report.id }, select: { status: true } })
    const u = await db.user.findUniqueOrThrow({ where: { id: reported }, select: { suspended_at: true } })
    expect(r.status).toBe(firstWon ? "reviewed" : "resolved")
    expect(u.suspended_at === null).toBe(firstWon)
    expect(await auditCount(report.id, "report.")).toBe(1)
  })
})

describe("an application", () => {
  async function application() {
    const email = `race-app-${testId("a").toLowerCase()}@toit.in`
    const r = await db.organiser_onboarding_requests.create({
      data: { kind: "company", display_name: testId("Race Applicant"), contact_name: "Race Host", contact_email: email, tier: "domain", status: "pending", email_verified_at: new Date(), requested_role: "organizer" },
      select: { id: true },
    })
    requests.push(r.id)
    return { id: r.id, email }
  }

  it("approve ∥ approve: one organisation, one account, one email (M1)", async () => {
    const app = await application()
    await race(() => approveOnboardingRequest(app.id), () => approveOnboardingRequest(app.id))

    const row = await db.organiser_onboarding_requests.findUniqueOrThrow({ where: { id: app.id }, select: { status: true, org_id: true } })
    expect(row.status).toBe("approved")
    expect(row.org_id).not.toBeNull()
    const owners = await db.organisation_members.count({ where: { user: { email: app.email } } })
    expect(owners).toBe(1)
    expect(await auditCount(app.id, "onboarding.")).toBe(1)
    expect(sent.filter((m) => m.to === app.email)).toHaveLength(1)
  })

  it("approve ∥ decline: one decision, and no organisation for a declined one", async () => {
    const app = await application()
    const { firstWon } = await race(() => approveOnboardingRequest(app.id), () => declineOnboardingRequest(app.id, REASON))

    const row = await db.organiser_onboarding_requests.findUniqueOrThrow({ where: { id: app.id }, select: { status: true, org_id: true } })
    expect(row.status).toBe(firstWon ? "approved" : "declined")
    expect(row.org_id === null).toBe(!firstWon)
    expect(await auditCount(app.id, "onboarding.")).toBe(1)
    expect(sent.filter((m) => m.to === app.email)).toHaveLength(1)
  })

  it("decline ∥ decline: one decline, one email", async () => {
    const app = await application()
    await race(() => declineOnboardingRequest(app.id, REASON), () => declineOnboardingRequest(app.id, REASON))
    expect(await auditCount(app.id, "onboarding.")).toBe(1)
    expect(sent.filter((m) => m.to === app.email)).toHaveLength(1)
  })
})

describe("only the words each queue takes, and a reason with every no (M2)", () => {
  it("refuses a decision that is not one, and writes nothing", async () => {
    const eventId = await curatedEvent()
    const orgId = await org()
    const claim = await db.event_claims.create({ data: { event_id: eventId, org_id: orgId, contact_email: "race-m2@toit.in", status: "pending" } })
    const brand = await db.sponsors.create({ data: { name: testId("M2 Brand"), name_key: testId("m2brand") } })
    sponsors.push(brand.id)
    const filer = await makeUser("m2_filer", "organizer")
    users.push(filer)
    const brandClaim = await db.sponsor_claims.create({ data: { sponsor_id: brand.id, org_id: orgId, filed_by: filer } })
    const venue = await db.venues.create({ data: { name: testId("M2 Venue"), city: "Bengaluru", latitude: 12.9, longitude: 77.6 } })
    venues.push(venue.id)
    const venueClaim = await db.venue_claims.create({ data: { venue_id: venue.id, org_id: orgId, filed_by: filer, status: "pending" } })
    const author = await makeUser("m2_author")
    users.push(author)
    const group = await db.chat_groups.create({ data: { event_id: eventId, name: testId("m2-room"), type: "event" } })
    const message = await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: author, content: "m2", moderation_status: "hidden", deleted_at: new Date() } })
    const flag = await db.moderation_flags.create({
      data: { message_id: message.id, chat_group_id: group.id, user_id: author, source: "auto_text", categories: {}, confidence: 0.9, status: "pending" },
    })
    const report = await db.user_reports.create({ data: { reporter_id: filer, reported_id: author, reason: "spam", status: "pending" } })

    const NOT_A_DECISION = "That is not a decision this queue takes."
    await expect(decideEventClaim(claim.id, "bogus" as never, REASON)).rejects.toThrow(NOT_A_DECISION)
    await expect(decideSponsorClaim(brandClaim.id, "REJECT" as never)).rejects.toThrow(NOT_A_DECISION)
    await expect(decideVenueClaim(venueClaim.id, "bogus" as never)).rejects.toThrow(NOT_A_DECISION)
    await expect(resolveFlag(flag.id, "bogus" as never)).rejects.toThrow(NOT_A_DECISION)
    await expect(resolveReport("user", report.id, "bogus" as never)).rejects.toThrow(NOT_A_DECISION)
    await expect(resolveReport("bogus" as never, report.id, "dismiss")).rejects.toThrow(NOT_A_DECISION)

    // And a no with no reason, on the server.
    await expect(decideEventClaim(claim.id, "decline", "no")).rejects.toThrow("Give a reason")
    await expect(decideSponsorClaim(brandClaim.id, "reject", "   short  ")).rejects.toThrow("Give a reason")
    await expect(decideVenueClaim(venueClaim.id, "decline")).rejects.toThrow("Give a reason")

    expect((await db.event_claims.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("pending")
    expect((await db.sponsor_claims.findUniqueOrThrow({ where: { id: brandClaim.id } })).status).toBe("pending")
    expect((await db.venue_claims.findUniqueOrThrow({ where: { id: venueClaim.id } })).status).toBe("pending")
    expect((await db.moderation_flags.findUniqueOrThrow({ where: { id: flag.id } })).status).toBe("pending")
    expect((await db.chat_messages.findUniqueOrThrow({ where: { id: message.id } })).deleted_at).not.toBeNull()
    expect((await db.user_reports.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("pending")
    expect(sent).toHaveLength(0)
  })
})
