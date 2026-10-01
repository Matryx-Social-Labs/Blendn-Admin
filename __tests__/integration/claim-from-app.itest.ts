/*
 * Claim from the app (step 1, plan v2 §3; test plan §5, CL-*).
 *
 * Two halves, both against real Postgres built with `db:migrate`, because the
 * rules that matter live in SQL that `db push` never creates:
 * `venue_claims_one_claimant`, `venue_claims_public_has_contact` and the
 * partial unique `venue_claims_one_pending_per_email`.
 *
 *   - The public venue page `/claim/venue/[venueId]` files a claim with no
 *     session, 404s an unknown, malformed or retired id, and changes no
 *     ownership. Approving needs the application approved first.
 *   - `GET /events/:eventId` carries `claim: { url }` only for a curated event
 *     nobody has claimed, on the dashboard host.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("next/headers", () => ({ headers: jest.fn().mockResolvedValue({ get: () => "203.0.113.46" }) }))

import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { decideVenueClaim, filePublicVenueClaim, getVenueClaimQueue } from "@/lib/venue-claim-actions"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const page = require("@/app/claim/venue/[venueId]/page") as typeof import("@/app/claim/venue/[venueId]/page")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const requests: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.venue_claims.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

beforeEach(() => mockGetAuth.mockResolvedValue(null))

async function venue(data: { status?: "active" | "archived"; deleted?: boolean; ownerOrgId?: string } = {}) {
  const v = await db.venues.create({
    data: {
      name: testId("Venue"),
      city: "Bengaluru",
      latitude: 12.9716,
      longitude: 77.5946,
      status: data.status ?? "active",
      deleted_at: data.deleted ? new Date() : null,
      owner_org_id: data.ownerOrgId ?? null,
      claimed_at: data.ownerOrgId ? new Date() : null,
    },
    select: { id: true },
  })
  venues.push(v.id)
  return v.id
}

/** What `/api/onboarding/apply` writes for the public form: a venue owner's application. */
async function application(role: "venue_owner" | "organizer" = "venue_owner") {
  const r = await db.organiser_onboarding_requests.create({
    data: {
      kind: "company",
      display_name: testId("Applicant"),
      legal_name: "Applicant Hospitality Pvt Ltd",
      contact_name: "Claimant",
      contact_email: `${testId("claimant")}@itest.invalid`,
      tier: "needs_proof",
      status: "pending",
      requested_role: role,
    },
    select: { id: true, contact_email: true },
  })
  requests.push(r.id)
  return r
}

async function org() {
  const o = await db.organisations.create({
    data: { kind: "company", display_name: testId("Owner Org"), status: "verified" },
    select: { id: true },
  })
  orgs.push(o.id)
  return o.id
}

const render = (venueId: string) => page.default({ params: Promise.resolve({ venueId }) })
const notFound = { digest: expect.stringContaining("404") }

describe("the public venue claim page", () => {
  it("renders an unclaimed venue with no session", async () => {
    await expect(render(await venue())).resolves.toBeTruthy()
  })

  it.each([
    ["an unknown id", async () => "6f1c1f0e-8f36-4c33-9a43-0d3f2b6f9a11"],
    ["a malformed id", async () => "not-a-uuid"],
    ["an archived venue", () => venue({ status: "archived" })],
    ["a deleted venue", () => venue({ deleted: true })],
  ])("answers %s as not found", async (_label, id) => {
    await expect(render(await id())).rejects.toMatchObject(notFound)
  })
})

describe("filing a venue claim with no account", () => {
  it("files a pending claim against the application and changes no ownership", async () => {
    const venueId = await venue()
    const app = await application()

    const filed = await filePublicVenueClaim({
      venueId,
      contactEmail: app.contact_email.toUpperCase(),
      onboardingId: app.id,
      gstin: " 29aabcu9603r1zj ",
      note: "  I run it.  ",
    })

    expect(filed).toMatchObject({ ok: true })
    expect(mockGetAuth).not.toHaveBeenCalled()
    const claim = await db.venue_claims.findFirstOrThrow({ where: { venue_id: venueId } })
    expect(claim).toMatchObject({
      status: "pending",
      org_id: null,
      filed_by: null,
      onboarding_id: app.id,
      contact_email: app.contact_email.toLowerCase(),
      note: "I run it.",
      gstin: "29AABCU9603R1ZJ",
      is_dispute: false,
    })
    const after = await db.venues.findUniqueOrThrow({ where: { id: venueId }, select: { owner_org_id: true, claimed_at: true } })
    expect(after).toEqual({ owner_org_id: null, claimed_at: null })
  })

  it("refuses an application that is not this address's, or not a venue owner's", async () => {
    const venueId = await venue()
    const mine = await application()
    const organiser = await application("organizer")

    await expect(
      filePublicVenueClaim({ venueId, contactEmail: "someone.else@itest.invalid", onboardingId: mine.id })
    ).resolves.toEqual({ ok: false, error: "That application does not match this email address" })
    await expect(
      filePublicVenueClaim({ venueId, contactEmail: organiser.contact_email, onboardingId: organiser.id })
    ).resolves.toEqual({ ok: false, error: "That application is not for a venue" })
    await expect(
      filePublicVenueClaim({ venueId, contactEmail: mine.contact_email, onboardingId: mine.id, gstin: "29AABCU9603R1ZX" })
    ).resolves.toMatchObject({ ok: false })
    expect(await db.venue_claims.count({ where: { venue_id: venueId } })).toBe(0)
  })

  it("refuses an owned, retired or unknown venue, and writes nothing", async () => {
    const app = await application()
    const owned = await venue({ ownerOrgId: await org() })
    const archived = await venue({ status: "archived" })

    const file = (venueId: string) =>
      filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })
    await expect(file(owned)).resolves.toEqual({ ok: false, error: "This place already has an owner on Blend'n" })
    await expect(file(archived)).resolves.toEqual({ ok: false, error: "Venue not found" })
    await expect(file("not-a-uuid")).resolves.toEqual({ ok: false, error: "Venue not found" })
    expect(await db.venue_claims.count({ where: { venue_id: { in: [owned, archived] } } })).toBe(0)
  })

  it("holds one pending claim per address per venue", async () => {
    const venueId = await venue()
    const app = await application()
    const file = () => filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })

    await expect(file()).resolves.toMatchObject({ ok: true })
    await expect(file()).resolves.toEqual({
      ok: false,
      error: "You already have a claim on this place waiting for review",
    })
    expect(await db.venue_claims.count({ where: { venue_id: venueId } })).toBe(1)
  })

  it("is held by the database to exactly one route in, with an address on the no-account one", async () => {
    const venueId = await venue()
    const app = await application()
    const orgId = await org()

    // Neither an organisation nor an application: nothing to approve into.
    await expect(db.venue_claims.create({ data: { venue_id: venueId, contact_email: "x@itest.invalid" } })).rejects.toThrow(
      /venue_claims_one_claimant/
    )
    // Both: two answers to one question.
    await expect(
      db.venue_claims.create({ data: { venue_id: venueId, org_id: orgId, onboarding_id: app.id, filed_by: "u" } })
    ).rejects.toThrow(/venue_claims_one_claimant/)
    // No account and no address: nobody to write back to.
    await expect(db.venue_claims.create({ data: { venue_id: venueId, onboarding_id: app.id } })).rejects.toThrow(
      /venue_claims_public_has_contact/
    )
  })
})

describe("deciding a no-account venue claim", () => {
  const asAdmin = () => mockGetAuth.mockResolvedValue({ user: { id: "itest-admin", role: "app_admin" } })

  it("shows it in the queue as waiting on its application, and refuses to approve until it is approved", async () => {
    const venueId = await venue()
    const app = await application()
    const filed = await filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })
    if (!filed.ok) throw new Error(filed.error)

    asAdmin()
    const row = (await getVenueClaimQueue()).find((r) => r.id === filed.claimId)
    expect(row).toMatchObject({ awaitingApplication: true, contactEmail: app.contact_email, filedByName: null })

    await expect(decideVenueClaim(filed.claimId, "approve")).rejects.toThrow(/Approve their application first/)
    const venueRow = await db.venues.findUniqueOrThrow({ where: { id: venueId }, select: { owner_org_id: true } })
    expect(venueRow.owner_org_id).toBeNull()
  })

  it("hands the venue to the organisation the approved application created", async () => {
    const venueId = await venue()
    const app = await application()
    const filed = await filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })
    if (!filed.ok) throw new Error(filed.error)
    const orgId = await org()
    await db.organiser_onboarding_requests.update({ where: { id: app.id }, data: { status: "approved", org_id: orgId } })

    asAdmin()
    const row = (await getVenueClaimQueue()).find((r) => r.id === filed.claimId)
    expect(row).toMatchObject({ awaitingApplication: false })

    await decideVenueClaim(filed.claimId, "approve")

    const venueRow = await db.venues.findUniqueOrThrow({ where: { id: venueId }, select: { owner_org_id: true, claimed_at: true } })
    expect(venueRow.owner_org_id).toBe(orgId)
    expect(venueRow.claimed_at).not.toBeNull()
    const claim = await db.venue_claims.findUniqueOrThrow({ where: { id: filed.claimId } })
    expect(claim).toMatchObject({ status: "approved", org_id: orgId, onboarding_id: null })
  })
})

describe("GET /events/:eventId — claim", () => {
  const ORIGINAL_HOST = process.env.DASHBOARD_HOST
  afterAll(() => {
    if (ORIGINAL_HOST === undefined) delete process.env.DASHBOARD_HOST
    else process.env.DASHBOARD_HOST = ORIGINAL_HOST
  })

  async function viewer() {
    const id = await makeUser("claim_viewer")
    users.push(id)
    await db.profiles.create({ data: { id, name: "Viewer", onboarded: true } })
    const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    return signAccessToken(id, user.email)
  }

  async function eventIn(state: "curated_open" | "curated_claimed" | "organiser") {
    const host = await makeUser("claim_host", "organizer")
    users.push(host)
    const id = await makeEvent(host)
    events.push(id)
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await db.events.update({
      where: { id },
      data: {
        start_time: start,
        end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        curated_at: state === "organiser" ? null : new Date(),
        claimed_at: state === "curated_claimed" ? new Date() : null,
      },
    })
    return id
  }

  async function claimOf(eventId: string, token: string) {
    const res = await eventRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}`, { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { claim: { url: string } | null } }).data.claim
  }

  it("offers the claim page on the dashboard host for a curated event nobody claimed, and nothing else", async () => {
    process.env.DASHBOARD_HOST = "staging-dashboard.blendn.app"
    const token = await viewer()
    const open = await eventIn("curated_open")

    const claim = await claimOf(open, token)
    expect(claim).toEqual({ url: `https://staging-dashboard.blendn.app/claim/${open}` })
    // Names the event and nothing about whoever is looking.
    expect(claim!.url).not.toMatch(/[?#]/)

    await expect(claimOf(await eventIn("curated_claimed"), token)).resolves.toBeNull()
    await expect(claimOf(await eventIn("organiser"), token)).resolves.toBeNull()
  })
})
