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
// One network per test, so the limiter's IP window (10 an hour) never trips a
// test that is not about it, and the one that is starts from zero.
let mockIp = "203.0.113.46"
jest.mock("next/headers", () => ({ headers: jest.fn(async () => ({ get: () => mockIp })) }))
const mockNotify = jest.fn()
jest.mock("@/lib/claim-decision-notify", () => ({
  ...jest.requireActual("@/lib/claim-decision-notify"),
  notifyClaimant: (...a: unknown[]) => mockNotify(...a),
}))

import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import type { ReactNode } from "react"

import { VenueClaimForm } from "@/app/claim/venue/[venueId]/claim-form"

import { db as appDb } from "@/lib/db"
import { signAccessToken } from "@/lib/mobile-auth"
import { fileEventClaim } from "@/lib/event-claim-actions"
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

beforeEach(() => {
  mockGetAuth.mockResolvedValue(null)
  mockNotify.mockReset().mockResolvedValue(true)
  mockIp = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID()}`
})

/** Whether a rendered tree holds an element of this component — the form, not just "something". */
function contains(node: ReactNode, type: unknown): boolean {
  if (!node || typeof node !== "object") return false
  if (Array.isArray(node)) return node.some((n) => contains(n, type))
  const el = node as { type?: unknown; props?: { children?: ReactNode } }
  return el.type === type || contains(el.props?.children, type)
}

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
  it("renders the form for an unclaimed venue with no session, and no form for an owned one", async () => {
    expect(contains(await render(await venue()), VenueClaimForm)).toBe(true)
    expect(contains(await render(await venue({ ownerOrgId: await org() })), VenueClaimForm)).toBe(false)
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

  it("refuses a note past 1,000 characters and an email that is not a string, writing nothing", async () => {
    const venueId = await venue()
    const app = await application()
    await expect(
      filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id, note: "x".repeat(1001) })
    ).resolves.toEqual({ ok: false, error: "Keep the note under 1,000 characters" })
    await expect(
      filePublicVenueClaim({ venueId, contactEmail: 42 as unknown as string, onboardingId: app.id })
    ).resolves.toEqual({ ok: false, error: "Check what you entered and try again" })
    expect(await db.venue_claims.count({ where: { venue_id: venueId } })).toBe(0)
  })

  it("is rate-limited: the sixth filing from one address in an hour is refused", async () => {
    const venueId = await venue()
    const app = await application()
    const file = () => filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })
    for (let i = 0; i < 5; i++) await file()
    await expect(file()).resolves.toEqual({
      ok: false,
      error: "You have filed several claims recently. Give us a little time to read them.",
    })
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

  /** The applicant clicked the link we sent. */
  const confirm = (requestId: string) =>
    db.organiser_onboarding_requests.update({ where: { id: requestId }, data: { email_verified_at: new Date() } })
  /** A reviewer approved the application, which created this organisation. */
  const approve = (requestId: string, orgId: string) =>
    db.organiser_onboarding_requests.update({ where: { id: requestId }, data: { status: "approved", org_id: orgId } })

  async function filed() {
    const venueId = await venue()
    const app = await application()
    const result = await filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })
    if (!result.ok) throw new Error(result.error)
    return { venueId, app, claimId: result.claimId }
  }

  const ownerOf = async (venueId: string) =>
    (await db.venues.findUniqueOrThrow({ where: { id: venueId }, select: { owner_org_id: true } })).owner_org_id

  it("waits on the address, then the application, in the queue and at approval", async () => {
    const { venueId, app, claimId } = await filed()
    asAdmin()
    const rowNow = async () => (await getVenueClaimQueue()).find((r) => r.id === claimId)

    expect(await rowNow()).toMatchObject({ waitingOn: "email", contactEmail: app.contact_email, filedByName: null })
    await expect(decideVenueClaim(claimId, "approve")).rejects.toThrow(/not confirmed yet/)

    // An application approved before its link was clicked is still an address nobody proved.
    await approve(app.id, await org())
    expect(await rowNow()).toMatchObject({ waitingOn: "email" })
    await expect(decideVenueClaim(claimId, "approve")).rejects.toThrow(/not confirmed yet/)
    expect(await ownerOf(venueId)).toBeNull()
  })

  it("refuses to approve a confirmed claim whose application is not approved", async () => {
    const { venueId, app, claimId } = await filed()
    await confirm(app.id)
    asAdmin()
    expect((await getVenueClaimQueue()).find((r) => r.id === claimId)).toMatchObject({ waitingOn: "application" })
    await expect(decideVenueClaim(claimId, "approve")).rejects.toThrow(/Approve their application first/)
    expect(await ownerOf(venueId)).toBeNull()
  })

  it("hands the venue to the organisation the confirmed, approved application created", async () => {
    const { venueId, app, claimId } = await filed()
    const orgId = await org()
    await confirm(app.id)
    await approve(app.id, orgId)

    asAdmin()
    expect((await getVenueClaimQueue()).find((r) => r.id === claimId)).toMatchObject({ waitingOn: null })
    await decideVenueClaim(claimId, "approve")

    const venueRow = await db.venues.findUniqueOrThrow({ where: { id: venueId }, select: { owner_org_id: true, claimed_at: true } })
    expect(venueRow.owner_org_id).toBe(orgId)
    expect(venueRow.claimed_at).not.toBeNull()
    expect(await db.venue_claims.findUniqueOrThrow({ where: { id: claimId } })).toMatchObject({
      status: "approved",
      org_id: orgId,
      onboarding_id: null,
    })
    // There is no user to look up: the confirmed address they filed with is who hears.
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ to: app.contact_email, outcome: "approved" }))
  })

  it("writes a decline to a confirmed address, and to an unconfirmed one not at all", async () => {
    const confirmed = await filed()
    await confirm(confirmed.app.id)
    const unconfirmed = await filed()

    asAdmin()
    await decideVenueClaim(confirmed.claimId, "decline", "We could not match the legal name to the venue.")
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ to: confirmed.app.contact_email, outcome: "declined", reason: "We could not match the legal name to the venue." })
    )
    mockNotify.mockClear()
    // Whatever a stranger typed is not an address to send our mail to.
    await expect(decideVenueClaim(unconfirmed.claimId, "decline", "We could not match the legal name to the venue.")).resolves.toEqual({
      notified: false,
    })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("refuses to approve over an owner given since the claim was filed", async () => {
    const { venueId, app, claimId } = await filed()
    await confirm(app.id)
    await approve(app.id, await org())
    const incumbent = await org()
    await db.venues.update({ where: { id: venueId }, data: { owner_org_id: incumbent, claimed_at: new Date() } })

    asAdmin()
    await expect(decideVenueClaim(claimId, "approve")).rejects.toThrow(/given an owner since the claim was filed/)
    expect(await ownerOf(venueId)).toBe(incumbent)
  })

  it("refuses, rather than failing on the unique index, when the organisation already has its own claim on the venue", async () => {
    const { venueId, app, claimId } = await filed()
    const orgId = await org()
    await confirm(app.id)
    await approve(app.id, orgId)
    // Once the account existed, the same organisation also claimed from its dashboard.
    await db.venue_claims.create({ data: { venue_id: venueId, org_id: orgId, filed_by: "itest-filer", status: "declined" } })

    asAdmin()
    await expect(decideVenueClaim(claimId, "approve")).rejects.toThrow(/already has its own claim on this venue/)
    expect(await ownerOf(venueId)).toBeNull()
    expect(await db.venue_claims.findUniqueOrThrow({ where: { id: claimId } })).toMatchObject({ status: "pending" })
  })

  /*
   * Two reviewers deciding at once both pass the checks before the write. A
   * real race does not reproduce reliably in a test, so the other reviewer's
   * write is injected at the one point between the checks and the
   * transaction: the read of the other pending claims.
   */
  async function decidedWhileReading(claimId: string, meanwhile: () => Promise<unknown>) {
    const read = appDb.venue_claims.findMany.bind(appDb.venue_claims)
    const spy = jest.spyOn(appDb.venue_claims, "findMany").mockImplementationOnce((async (args: never) => {
      await meanwhile()
      return read(args)
    }) as never)
    try {
      return await decideVenueClaim(claimId, "approve")
    } finally {
      spy.mockRestore()
    }
  }

  it("re-checks the owner inside the transaction: an owner given mid-decision is not overwritten", async () => {
    const { venueId, app, claimId } = await filed()
    await confirm(app.id)
    await approve(app.id, await org())
    const incumbent = await org()

    asAdmin()
    await expect(
      decidedWhileReading(claimId, () =>
        db.venues.update({ where: { id: venueId }, data: { owner_org_id: incumbent, claimed_at: new Date() } })
      )
    ).rejects.toThrow(/given an owner since the claim was filed/)
    expect(await ownerOf(venueId)).toBe(incumbent)
    expect(await db.venue_claims.findUniqueOrThrow({ where: { id: claimId } })).toMatchObject({ status: "pending" })
  })

  it("re-checks the claim inside the transaction: one decided mid-decision is not decided twice", async () => {
    const { venueId, app, claimId } = await filed()
    await confirm(app.id)
    await approve(app.id, await org())

    asAdmin()
    await expect(
      decidedWhileReading(claimId, () => db.venue_claims.update({ where: { id: claimId }, data: { status: "declined" } }))
    ).rejects.toThrow(/already been decided/)
    expect(await ownerOf(venueId)).toBeNull()
  })

  it("flags what a reviewer has to weigh on a claim from a stranger", async () => {
    const venueId = await venue()
    const r = await db.organiser_onboarding_requests.create({
      data: {
        kind: "company",
        display_name: testId("Applicant"),
        legal_name: "Applicant Hospitality Pvt Ltd",
        contact_name: "Claimant",
        contact_email: `${testId("owner")}@gmail.com`,
        website: "https://thevenue.in",
        tier: "needs_proof",
        status: "pending",
        requested_role: "venue_owner",
      },
      select: { id: true, contact_email: true },
    })
    requests.push(r.id)
    const result = await filePublicVenueClaim({
      venueId,
      contactEmail: r.contact_email,
      onboardingId: r.id,
      gstin: "29AABCU9603R1ZJ",
    })
    if (!result.ok) throw new Error(result.error)

    asAdmin()
    const row = (await getVenueClaimQueue()).find((q) => q.id === result.claimId)!
    expect(row.flags).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/free email address \(gmail\.com\)/),
        expect.stringMatching(/GSTIN passes its checksum only/),
      ])
    )
  })
})

describe("the public claim actions take any input without a 500", () => {
  it("refuses a null input, non-string fields and an oversized address — quickly", async () => {
    const venueId = await venue()
    const app = await application()
    await expect(filePublicVenueClaim(null as never)).resolves.toMatchObject({ ok: false })
    await expect(
      filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id, gstin: 7 as never })
    ).resolves.toMatchObject({ ok: false })

    // The old pattern backtracked: this held the event loop for ~450 ms.
    const hostile = `${"a.".repeat(8000)}@`
    const started = performance.now()
    await expect(fileEventClaim({ eventId: randomUUID(), contactEmail: hostile })).resolves.toMatchObject({ ok: false })
    await expect(filePublicVenueClaim({ venueId, contactEmail: hostile, onboardingId: app.id })).resolves.toMatchObject({ ok: false })
    expect(performance.now() - started).toBeLessThan(200)
    expect(await db.venue_claims.count({ where: { venue_id: venueId } })).toBe(0)
  })

  it("refuses a claim against a declined application", async () => {
    const venueId = await venue()
    const app = await application()
    await db.organiser_onboarding_requests.update({ where: { id: app.id }, data: { status: "declined" } })
    await expect(filePublicVenueClaim({ venueId, contactEmail: app.contact_email, onboardingId: app.id })).resolves.toEqual({
      ok: false,
      error: "That application was declined, so there is nothing to file this claim against",
    })
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
