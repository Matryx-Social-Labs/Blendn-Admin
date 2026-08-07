const mockDb = {
  events: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  organisation_members: { findMany: jest.fn() },
}
const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import {
  disputeVenueLink,
  confirmVenueLink,
  unlinkEventVenue,
  getLinkedEventsForOwner,
} from "@/lib/venue-link-actions"

const EVENT = "event_1"
const MY_ORG = "org_mine"
const THEIR_ORG = "org_theirs"
const REASON = "This event is not at our venue at all."

function signIn(role: string, orgIds: string[] = [MY_ORG]) {
  mockAuth.mockResolvedValue({ user: { id: "user_1", role } })
  mockDb.organisation_members.findMany.mockResolvedValue(orgIds.map((org_id) => ({ org_id })))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.events.update.mockResolvedValue({})
})

/**
 * Layer 4 — the reversible auto-link.
 *
 * The venue-claim design leans on this: a wrong approval is recoverable, so the
 * other three safeguards do not have to be perfect. Until this module existed
 * that was a promise with no implementation — `disputed` was written by nothing.
 *
 * The two directions are deliberately asymmetric, and these tests are mostly
 * about keeping them that way.
 */

describe("disputeVenueLink — the venue owner's side", () => {
  const linked = {
    id: EVENT,
    title: "Someone else's night",
    venue_id: "venue_1",
    venue_link_status: "auto_linked",
    venue: { owner_org_id: MY_ORG, name: "Toit" },
  }

  it("lets the owner of that venue flag it", async () => {
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await disputeVenueLink(EVENT, REASON)
    expect(mockDb.events.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { venue_link_status: "disputed" } })
    )
  })

  it("does NOT detach the event", async () => {
    // An owner who could unlink freely could hide events they would rather not
    // answer for. Disputing flags; detaching is the organiser's call.
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await disputeVenueLink(EVENT, REASON)
    const data = mockDb.events.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("venue_id")
  })

  it("refuses someone who owns a different venue", async () => {
    signIn("venue_owner", [THEIR_ORG])
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(disputeVenueLink(EVENT, REASON)).rejects.toThrow(/forbidden/i)
    expect(mockDb.events.update).not.toHaveBeenCalled()
  })

  it("refuses when the venue has no owner at all", async () => {
    // owner_org_id null must not match an actor whose orgIds happen to contain
    // undefined-ish values.
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue({ ...linked, venue: { owner_org_id: null, name: "Toit" } })
    await expect(disputeVenueLink(EVENT, REASON)).rejects.toThrow(/forbidden/i)
  })

  it("requires a reason", async () => {
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(disputeVenueLink(EVENT, "nope")).rejects.toThrow(/say why/i)
    expect(mockDb.events.findUnique).not.toHaveBeenCalled()
  })

  it("refuses an event with no venue link", async () => {
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue({ ...linked, venue_id: null })
    await expect(disputeVenueLink(EVENT, REASON)).rejects.toThrow(/not linked/i)
  })

  it("is idempotent — a second dispute is a no-op", async () => {
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue({ ...linked, venue_link_status: "disputed" })
    await disputeVenueLink(EVENT, REASON)
    expect(mockDb.events.update).not.toHaveBeenCalled()
  })
})

describe("confirmVenueLink", () => {
  const linked = {
    id: EVENT,
    venue_id: "venue_1",
    venue: { owner_org_id: MY_ORG, name: "Toit" },
  }

  it("can only be set by the venue owner, never from a request", async () => {
    // The whole reason lib/venue-link.ts ignores the body's value: a client
    // that could send `confirmed` would attach its event to someone else's
    // venue and mark it agreed in one call.
    signIn("venue_owner")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await confirmVenueLink(EVENT)
    expect(mockDb.events.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { venue_link_status: "confirmed" } })
    )
  })

  it("refuses anyone outside the owning organisation, whatever their role", async () => {
    // Authorization here resolves on org membership, not identity or role —
    // the same rule as lib/rbac.ts eventPermissions. The org that owns the
    // venue speaks for it, whoever in that org clicks.
    signIn("venue_owner", [THEIR_ORG])
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(confirmVenueLink(EVENT)).rejects.toThrow(/forbidden/i)

    signIn("organizer", [THEIR_ORG])
    await expect(confirmVenueLink(EVENT)).rejects.toThrow(/forbidden/i)
  })

  it("allows a member of the owning org whose role is organizer", async () => {
    // An org can hold both organisers and venue owners. Denying on role would
    // mean the wrong colleague clicking gets a permission error on a venue
    // their own company owns.
    signIn("organizer", [MY_ORG])
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(confirmVenueLink(EVENT)).resolves.toBeUndefined()
  })
})

describe("unlinkEventVenue — the organiser's side", () => {
  const linked = {
    id: EVENT,
    venue_id: "venue_1",
    venue_name: "Toit Brewpub",
    organizer_org_id: MY_ORG,
    venue: { name: "Toit" },
  }

  it("detaches immediately, with no review", async () => {
    // Nobody should have to wait on an admin to stop a stranger seeing their
    // attendee list.
    signIn("organizer")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await unlinkEventVenue(EVENT, REASON)
    const data = mockDb.events.update.mock.calls[0][0].data
    expect(data.venue_id).toBeNull()
    expect(data.venue_link_status).toBeNull()
  })

  it("keeps the venue name as free text", async () => {
    // The event really was held there. Clearing it would punish an organiser
    // for correcting a bad link.
    signIn("organizer")
    mockDb.events.findUnique.mockResolvedValue(linked)
    await unlinkEventVenue(EVENT, REASON)
    expect(mockDb.events.update.mock.calls[0][0].data.venue_name).toBe("Toit Brewpub")
  })

  it("falls back to the venue's own name when the event had none", async () => {
    signIn("organizer")
    mockDb.events.findUnique.mockResolvedValue({ ...linked, venue_name: null })
    await unlinkEventVenue(EVENT, REASON)
    expect(mockDb.events.update.mock.calls[0][0].data.venue_name).toBe("Toit")
  })

  it("refuses an organiser from a different org", async () => {
    signIn("organizer", [THEIR_ORG])
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(unlinkEventVenue(EVENT, REASON)).rejects.toThrow(/forbidden/i)
  })

  it("refuses the venue owner — disputing is their route, not detaching", async () => {
    signIn("venue_owner", [THEIR_ORG])
    mockDb.events.findUnique.mockResolvedValue(linked)
    await expect(unlinkEventVenue(EVENT, REASON)).rejects.toThrow(/forbidden/i)
  })

  it("requires a reason", async () => {
    signIn("organizer")
    await expect(unlinkEventVenue(EVENT, "x")).rejects.toThrow(/give a reason/i)
  })

  it("lets an admin unlink anything", async () => {
    signIn("app_admin", [])
    mockDb.events.findUnique.mockResolvedValue({ ...linked, organizer_org_id: THEIR_ORG })
    await expect(unlinkEventVenue(EVENT, REASON)).resolves.toBeUndefined()
  })
})

describe("getLinkedEventsForOwner", () => {
  beforeEach(() => mockDb.events.findMany.mockResolvedValue([]))

  it("scopes to venues the caller's org owns", async () => {
    signIn("venue_owner")
    await getLinkedEventsForOwner()
    expect(mockDb.events.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venue_id: { not: null },
          venue: { owner_org_id: { in: [MY_ORG] } },
        }),
      })
    )
  })

  it("does not scope for an admin", async () => {
    signIn("app_admin", [])
    await getLinkedEventsForOwner()
    expect(mockDb.events.findMany.mock.calls[0][0].where.venue).toBeUndefined()
  })

  it("returns nothing for an organiser rather than throwing", async () => {
    // This feeds a screen an organiser can reach; an empty list is the right
    // answer, not an error page.
    signIn("organizer")
    expect(await getLinkedEventsForOwner()).toEqual([])
    expect(mockDb.events.findMany).not.toHaveBeenCalled()
  })

  it("refuses a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(getLinkedEventsForOwner()).rejects.toThrow(/unauthorized/i)
  })
})
