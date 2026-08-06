const mockDb = {
  venues: { findUnique: jest.fn(), update: jest.fn() },
  venue_claims: { upsert: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  organisation_members: { findFirst: jest.fn() },
  user: { findMany: jest.fn() },
  $transaction: jest.fn(),
}

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { fileVenueClaim, decideVenueClaim, getVenueClaimQueue } from "@/lib/venue-claim-actions"

const VENUE = "venue_1"
const MY_ORG = "org_mine"
const THEIR_ORG = "org_theirs"
/** Real checksum, computed rather than invented — an earlier fixture failed validation. */
const VALID_GSTIN = "29AABCU9603R1ZJ"

function signIn(role: string, id = "user_1") {
  mockAuth.mockResolvedValue({ user: { id, role } })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.organisation_members.findFirst.mockResolvedValue({ org_id: MY_ORG })
  mockDb.venue_claims.upsert.mockResolvedValue({ id: "claim_1" })
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb))
})

/**
 * A venue claim is an access request, not data entry.
 *
 * Approving one hands the claimant the chatroom, attendee list and feedback for
 * events other organisers hold at that venue. So the tests that matter are the
 * ones about who may ask and what happens to everyone else's pending request.
 */

describe("who may file a claim", () => {
  it("refuses an organiser outright", async () => {
    // The reason this is a hard no rather than a review: a venue grants control
    // over other people's events, and an organiser has no claim to that.
    signIn("organizer")
    await expect(
      fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })
    ).rejects.toThrow(/only a venue owner/i)
    expect(mockDb.venue_claims.upsert).not.toHaveBeenCalled()
  })

  it("refuses an attendee", async () => {
    signIn("attendee")
    await expect(
      fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })
    ).rejects.toThrow(/only a venue owner/i)
  })

  it("refuses a signed-out caller before touching the database", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(
      fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })
    ).rejects.toThrow(/unauthorized/i)
    expect(mockDb.venues.findUnique).not.toHaveBeenCalled()
  })
})

describe("evidence", () => {
  beforeEach(() => {
    signIn("venue_owner")
    mockDb.venues.findUnique.mockResolvedValue({ id: VENUE, name: "Toit", owner_org_id: null })
  })

  it("requires a trade licence — it is the document that names the address", async () => {
    await expect(fileVenueClaim({ venueId: VENUE, evidence: {} })).rejects.toThrow(
      /trade licence/i
    )
  })

  it("accepts a claim with only a trade licence", async () => {
    // FSSAI and liquor vary by venue type; a park has neither, and requiring
    // them would block honest claims.
    await expect(
      fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "https://x/licence.pdf" } })
    ).resolves.toEqual({ id: "claim_1", isDispute: false })
  })

  it("rejects a GSTIN that fails its check digit", async () => {
    await expect(
      fileVenueClaim({
        venueId: VENUE,
        gstin: "29AABCU9603R1ZX",
        evidence: { tradeLicence: "u" },
      })
    ).rejects.toThrow()
  })

  it("accepts and upper-cases a valid GSTIN", async () => {
    await fileVenueClaim({
      venueId: VENUE,
      gstin: VALID_GSTIN.toLowerCase(),
      evidence: { tradeLicence: "u" },
    })
    expect(mockDb.venue_claims.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ gstin: VALID_GSTIN }) })
    )
  })
})

describe("claiming a venue that already has an owner", () => {
  beforeEach(() => signIn("venue_owner"))

  it("files as a dispute rather than refusing", async () => {
    // Refusing would leave a genuine owner with no route at all when the wrong
    // organisation claimed first.
    mockDb.venues.findUnique.mockResolvedValue({
      id: VENUE,
      name: "Toit",
      owner_org_id: THEIR_ORG,
    })
    const result = await fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })
    expect(result.isDispute).toBe(true)
    expect(mockDb.venue_claims.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ is_dispute: true }) })
    )
  })

  it("refuses when the claimant already owns it", async () => {
    mockDb.venues.findUnique.mockResolvedValue({ id: VENUE, name: "Toit", owner_org_id: MY_ORG })
    await expect(
      fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })
    ).rejects.toThrow(/already owns/i)
  })
})

describe("re-filing", () => {
  it("updates the existing row rather than stacking duplicates", async () => {
    // A declined claimant who re-files should not produce a second queue entry
    // for a reviewer to wade through.
    signIn("venue_owner")
    mockDb.venues.findUnique.mockResolvedValue({ id: VENUE, name: "Toit", owner_org_id: null })
    await fileVenueClaim({ venueId: VENUE, evidence: { tradeLicence: "u" } })

    const call = mockDb.venue_claims.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ venue_id_org_id: { venue_id: VENUE, org_id: MY_ORG } })
    // The decision must be cleared, or a re-file inherits the old verdict.
    expect(call.update).toEqual(
      expect.objectContaining({ status: "pending", reviewed_by: null, decision_note: null })
    )
  })
})

describe("deciding a claim", () => {
  beforeEach(() => {
    signIn("app_admin", "admin_1")
    mockDb.venue_claims.findUnique.mockResolvedValue({
      id: "claim_1",
      status: "pending",
      org_id: MY_ORG,
      is_dispute: false,
      venue: { id: VENUE, name: "Toit", owner_org_id: null },
    })
  })

  it("refuses a non-admin", async () => {
    signIn("venue_owner")
    await expect(decideVenueClaim("claim_1", "approve")).rejects.toThrow(/forbidden/i)
  })

  it("refuses to decide a claim twice", async () => {
    mockDb.venue_claims.findUnique.mockResolvedValue({
      id: "claim_1",
      status: "approved",
      org_id: MY_ORG,
      is_dispute: false,
      venue: { id: VENUE, name: "Toit", owner_org_id: null },
    })
    await expect(decideVenueClaim("claim_1", "decline", "a good long reason")).rejects.toThrow(
      /already been decided/i
    )
  })

  it("transfers ownership and stamps claimed_at on approval", async () => {
    await decideVenueClaim("claim_1", "approve")
    expect(mockDb.venues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VENUE },
        data: expect.objectContaining({ owner_org_id: MY_ORG }),
      })
    )
  })

  it("declines every other pending claim on that venue in the same breath", async () => {
    // One owner per venue, so leaving the others pending would show a reviewer
    // a queue of requests for a venue that now has an owner.
    await decideVenueClaim("claim_1", "approve")
    expect(mockDb.venue_claims.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venue_id: VENUE,
          status: "pending",
          id: { not: "claim_1" },
        }),
        data: expect.objectContaining({ status: "declined" }),
      })
    )
  })

  it("requires a reason to decline", async () => {
    // A decline that reaches the claimant with no reason produces an identical
    // re-file, and the queue gets the same row again.
    await expect(decideVenueClaim("claim_1", "decline", "no")).rejects.toThrow(/give a reason/i)
    expect(mockDb.venue_claims.update).not.toHaveBeenCalled()
  })

  it("does not touch the venue when declining", async () => {
    await decideVenueClaim("claim_1", "decline", "The licence names a different address.")
    expect(mockDb.venues.update).not.toHaveBeenCalled()
    expect(mockDb.venue_claims.updateMany).not.toHaveBeenCalled()
  })
})

describe("the review queue", () => {
  beforeEach(() => {
    mockDb.user.findMany.mockResolvedValue([{ id: "user_1", name: "Ada" }])
  })

  it("is admin-only", async () => {
    signIn("venue_owner")
    await expect(getVenueClaimQueue()).rejects.toThrow(/forbidden/i)
  })

  it("surfaces the incumbent's hosting history as a flag on a dispute", async () => {
    // Six events at a venue is evidence, and a reviewer weighing two document
    // sets should see it without opening another screen.
    signIn("app_admin")
    mockDb.venue_claims.findMany.mockResolvedValue([
      {
        id: "claim_1",
        filed_by: "user_1",
        is_dispute: true,
        gstin: VALID_GSTIN,
        evidence: { tradeLicence: "u" },
        created_at: new Date("2026-01-01"),
        org: { display_name: "Mine Ltd" },
        venue: {
          id: VENUE,
          name: "Toit",
          address: "100 Feet Rd",
          city: "Bengaluru",
          venue_type: "brewery",
          owner_org_id: THEIR_ORG,
          owner_org: { display_name: "Theirs Ltd" },
          _count: { events: 6 },
        },
      },
    ])

    const [row] = await getVenueClaimQueue()
    expect(row.currentOwnerEventCount).toBe(6)
    expect(row.flags.join(" ")).toMatch(/Theirs Ltd.*6 hosted events/)
    // Rendered as a label, never the raw enum.
    expect(row.venueType).toBe("Brewery")
    expect(row.filedByName).toBe("Ada")
  })

  it("flags missing evidence without hiding the claim", async () => {
    signIn("app_admin")
    mockDb.venue_claims.findMany.mockResolvedValue([
      {
        id: "claim_2",
        filed_by: "user_1",
        is_dispute: false,
        gstin: null,
        evidence: {},
        created_at: new Date("2026-01-02"),
        org: { display_name: "Mine Ltd" },
        venue: {
          id: VENUE,
          name: "Toit",
          address: null,
          city: null,
          venue_type: null,
          owner_org_id: null,
          owner_org: null,
          _count: { events: 0 },
        },
      },
    ])

    const [row] = await getVenueClaimQueue()
    // Flags are things to weigh, not a score — a flagged claim can still be
    // the right one, so it stays in the queue.
    expect(row.flags).toEqual(
      expect.arrayContaining(["No trade licence attached", "No GSTIN given"])
    )
    expect(row.venueAddress).toBeNull()
    expect(row.venueType).toBe("Unclassified")
  })

  it("orders oldest first — age is the SLA", async () => {
    signIn("app_admin")
    mockDb.venue_claims.findMany.mockResolvedValue([])
    await getVenueClaimQueue()
    expect(mockDb.venue_claims.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { created_at: "asc" } })
    )
  })
})
