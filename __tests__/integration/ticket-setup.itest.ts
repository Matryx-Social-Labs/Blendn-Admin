import { createHash } from "crypto"

import { readOrganizerTicketingTerms } from "@/lib/legal-html"
import { reviewPayoutAccount, submitPayoutAccount } from "@/lib/payout-account"
import { saveExternalTicketLink, turnOnTicketing } from "@/lib/ticket-setup"

import { closeDb, db, makeUser, testId } from "./helpers"
import { fakeRazorpay, newWorld, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * Turning tickets on from the dashboard (SCRUM-1014): the terms accepted with
 * the hash of the text the server rendered, then `enableTicketing`; the payout
 * account an owner enters and an admin verifies; Canada's link out.
 */

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay

beforeAll(() => {
  restore = ticketEnv()
  fake = fakeRazorpay()
})
afterAll(async () => {
  jest.restoreAllMocks()
  // Acceptances are append-only evidence (Restrict on both sides): their organizations and people stay, as in legal-acceptance.itest.ts.
  const kept = await db.legal_acceptances.findMany({ where: { org_id: { in: w.orgs } }, select: { org_id: true, user_id: true } })
  const keptOrgs = new Set(kept.map((k) => k.org_id))
  const keptUsers = new Set(kept.map((k) => k.user_id))
  await db.organisation_members.deleteMany({ where: { org_id: { in: w.orgs } } })
  await teardown({ ...w, orgs: w.orgs.filter((o) => !keptOrgs.has(o)), users: w.users.filter((u) => !keptUsers.has(u)) })
  restore()
  await closeDb()
})

/** An org-owned event not yet selling, in a city of the given market. */
async function freshEvent(opts: { city?: string; accountStatus?: "not_started" | "pending" | "active" | "rejected" } = {}) {
  const world = await ticketedEvent(w, [], { accountStatus: opts.accountStatus ?? "active", account: opts.accountStatus === "not_started" ? null : undefined })
  await db.events.update({
    where: { id: world.eventId },
    data: { ticketing_mode: "off", ticketing_enabled_at: null, ticket_fee_rule: null, city: opts.city ?? "Bengaluru" },
  })
  await db.$executeRaw`UPDATE events SET ticket_fee_schedule = NULL WHERE id = ${world.eventId}::uuid`
  return world
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

describe("the organizer ticketing terms", () => {
  it("are the file's body, marked draft, hashed on the server", () => {
    const terms = readOrganizerTicketingTerms()
    expect(terms.version).toBe("0.1")
    expect(terms.body).toMatch(/DRAFT/)
    expect(terms.body).toMatch(/Organizer Ticketing Terms/)
    expect(terms.sha256).toBe(sha(terms.body))
  })
})

describe("turning ticket selling on", () => {
  it("records the acceptance with the rendered text's hash, then turns the event on with the chosen policy", async () => {
    const { eventId, host, orgId } = await freshEvent()
    const terms = readOrganizerTicketingTerms()
    const res = await turnOnTicketing(eventId, { id: host, role: "organizer" }, {
      documentSha256: terms.sha256,
      refundPolicy: "until_7d",
      feesAbsorbed: true,
      ip: "203.0.113.77",
      userAgent: "itest",
    })
    expect(res).toMatchObject({ ok: true })

    const acceptance = await db.legal_acceptances.findFirstOrThrow({ where: { org_id: orgId } })
    expect(acceptance).toMatchObject({ user_id: host, version: "0.1", document_sha256: terms.sha256, ip: "203.0.113.0/24" })
    const event = await db.events.findUniqueOrThrow({ where: { id: eventId } })
    expect(event).toMatchObject({ ticketing_mode: "native", refund_policy: "until_7d", fees_absorbed: true })
    expect(event.ticketing_enabled_at).not.toBeNull()
  })

  it("refuses a hash that is not the text the server serves now, and records nothing", async () => {
    const { eventId, host, orgId } = await freshEvent()
    const res = await turnOnTicketing(eventId, { id: host, role: "organizer" }, {
      documentSha256: sha("some other text"),
      refundPolicy: "none",
      feesAbsorbed: false,
    })
    expect(res).toMatchObject({ ok: false, reason: "terms_changed" })
    expect(await db.legal_acceptances.count({ where: { org_id: orgId } })).toBe(0)
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).ticketing_mode).toBe("off")
  })

  it("lets a staff member turn on an event once an owner accepted, and refuses them the acceptance itself", async () => {
    const terms = readOrganizerTicketingTerms()
    const first = await freshEvent()
    const staff = await makeUser(testId("tix-staff"), "organizer")
    w.users.push(staff)
    await db.organisation_members.create({ data: { org_id: first.orgId, user_id: staff, role: "staff" } })

    // Nobody accepted yet: staff cannot bind the organization.
    expect(await turnOnTicketing(first.eventId, { id: staff, role: "organizer" }, { documentSha256: terms.sha256, refundPolicy: "none", feesAbsorbed: false })).toMatchObject({
      ok: false,
      reason: "not_authorized",
    })
    expect(await db.legal_acceptances.count({ where: { org_id: first.orgId } })).toBe(0)

    // The owner accepts on this event; staff then turns on a second event of the same organization.
    expect(await turnOnTicketing(first.eventId, { id: first.host, role: "organizer" }, { documentSha256: terms.sha256, refundPolicy: "none", feesAbsorbed: false })).toMatchObject({ ok: true })
    const second = await db.events.create({
      data: { slug: testId("evt2"), title: "Second", description: "x", start_time: new Date(Date.now() + 86_400_000), end_time: new Date(Date.now() + 90_000_000), timezone: "UTC", status: "published", organizer_id: first.host, organizer_org_id: first.orgId, city: "Bengaluru" },
    })
    w.events.push(second.id)
    expect(await turnOnTicketing(second.id, { id: staff, role: "organizer" }, { documentSha256: terms.sha256, refundPolicy: "none", feesAbsorbed: false })).toMatchObject({ ok: true })
    expect(await db.legal_acceptances.count({ where: { org_id: first.orgId } })).toBe(1)
  })

  it("passes enableTicketing's refusal through: no payout account, no selling", async () => {
    const { eventId, host } = await freshEvent({ accountStatus: "pending" })
    const terms = readOrganizerTicketingTerms()
    expect(await turnOnTicketing(eventId, { id: host, role: "organizer" }, { documentSha256: terms.sha256, refundPolicy: "none", feesAbsorbed: false })).toMatchObject({
      ok: false,
      reason: "payouts_not_connected",
    })
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).ticketing_mode).toBe("off")
  })

  it("is nobody else's to turn on", async () => {
    const { eventId } = await freshEvent()
    const stranger = await makeUser(testId("tix-on-stranger"), "organizer")
    w.users.push(stranger)
    const terms = readOrganizerTicketingTerms()
    expect(await turnOnTicketing(eventId, { id: stranger, role: "organizer" }, { documentSha256: terms.sha256, refundPolicy: "none", feesAbsorbed: false })).toMatchObject({
      ok: false,
      reason: "not_authorized",
    })
  })
})

describe("the payout account", () => {
  it("an owner enters an acc_ id and it waits for Razorpay; an admin then marks it active after Razorpay says so", async () => {
    const { eventId, host, orgId } = await freshEvent({ accountStatus: "not_started" })
    expect(await submitPayoutAccount(eventId, { id: host, role: "organizer" }, "not-an-account")).toMatchObject({ ok: false, reason: "invalid" })
    expect(await submitPayoutAccount(eventId, { id: host, role: "organizer" }, "acc_ITESTSUBMIT001")).toEqual({ ok: true })
    expect(await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).toMatchObject({ razorpay_account_id: "acc_ITESTSUBMIT001", razorpay_account_status: "pending" })
    expect(await db.audit_logs.findFirst({ where: { action: "payouts.account_submitted", org_id: orgId } })).not.toBeNull()

    // The organizer cannot verify their own account.
    expect(await reviewPayoutAccount(orgId, { id: host, role: "organizer" }, "active")).toMatchObject({ ok: false, reason: "not_authorized" })

    const admin = await makeUser(testId("tix-admin"), "app_admin")
    w.users.push(admin)
    // Razorpay says it is still under review: not marked active.
    jest.mocked(global.fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ id: "acc_ITESTSUBMIT001", status: "under_review" }), { status: 200 }))
    expect(await reviewPayoutAccount(orgId, { id: admin, role: "app_admin" }, "active")).toMatchObject({ ok: false, reason: "razorpay_disagrees" })
    expect((await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).razorpay_account_status).toBe("pending")

    jest.mocked(global.fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ id: "acc_ITESTSUBMIT001", status: "activated" }), { status: 200 }))
    expect(await reviewPayoutAccount(orgId, { id: admin, role: "app_admin" }, "active")).toEqual({ ok: true })
    expect((await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).razorpay_account_status).toBe("active")
    const reviewed = await db.audit_logs.findFirst({ where: { action: "payouts.account_reviewed", org_id: orgId } })
    expect(reviewed?.details).toMatchObject({ decision: "active", razorpay: "activated" })

    // Once active, an organizer cannot swap the account underneath the payouts.
    expect(await submitPayoutAccount(eventId, { id: host, role: "organizer" }, "acc_ITESTSUBMIT002")).toMatchObject({ ok: false, reason: "already_active" })
  })

  it("refuses a member who is not an owner or admin", async () => {
    const { eventId, orgId } = await freshEvent({ accountStatus: "not_started" })
    const staff = await makeUser(testId("tix-pay-staff"), "organizer")
    w.users.push(staff)
    await db.organisation_members.create({ data: { org_id: orgId, user_id: staff, role: "staff" } })
    expect(await submitPayoutAccount(eventId, { id: staff, role: "organizer" }, "acc_ITESTSUBMIT003")).toMatchObject({ ok: false, reason: "not_authorized" })
    expect((await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).razorpay_account_status).toBe("not_started")
  })

  it("an admin can reject a pending account", async () => {
    const { eventId, host, orgId } = await freshEvent({ accountStatus: "not_started" })
    await submitPayoutAccount(eventId, { id: host, role: "organizer" }, "acc_ITESTSUBMIT004")
    const admin = await makeUser(testId("tix-admin2"), "app_admin")
    w.users.push(admin)
    expect(await reviewPayoutAccount(orgId, { id: admin, role: "app_admin" }, "rejected")).toEqual({ ok: true })
    expect((await db.organisations.findUniqueOrThrow({ where: { id: orgId } })).razorpay_account_status).toBe("rejected")
    expect(fake).toBeDefined()
  })
})

describe("Canada: a link out", () => {
  it("saves an https link on an event in an external market, and refuses http and a native market", async () => {
    const ca = await freshEvent({ city: "Toronto" })
    const host = { id: ca.host, role: "organizer" as const }
    expect(await saveExternalTicketLink(ca.eventId, host, "http://www.eventbrite.ca/e/1")).toMatchObject({ ok: false, reason: "invalid" })
    expect(await saveExternalTicketLink(ca.eventId, host, "javascript:alert(1)")).toMatchObject({ ok: false, reason: "invalid" })
    expect(await saveExternalTicketLink(ca.eventId, host, "https://www.eventbrite.ca/e/junction-1093847562")).toEqual({ ok: true, site: "eventbrite.ca" })
    expect(await db.events.findUniqueOrThrow({ where: { id: ca.eventId } })).toMatchObject({
      ticketing_mode: "external",
      external_ticket_url: "https://www.eventbrite.ca/e/junction-1093847562",
    })
    // Cleared, it is free again.
    expect(await saveExternalTicketLink(ca.eventId, host, "")).toEqual({ ok: true, site: null })
    expect(await db.events.findUniqueOrThrow({ where: { id: ca.eventId } })).toMatchObject({ ticketing_mode: "off", external_ticket_url: null })

    const india = await freshEvent({ city: "Bengaluru" })
    expect(await saveExternalTicketLink(india.eventId, { id: india.host, role: "organizer" }, "https://www.eventbrite.ca/e/1")).toMatchObject({ ok: false, reason: "market_not_external" })
  })

  it("never fetches the organizer's link", async () => {
    const ca = await freshEvent({ city: "Toronto" })
    const calls = jest.mocked(global.fetch).mock.calls.length
    await saveExternalTicketLink(ca.eventId, { id: ca.host, role: "organizer" }, "https://tickets.example.com/e/1")
    expect(jest.mocked(global.fetch).mock.calls.length).toBe(calls)
  })
})
