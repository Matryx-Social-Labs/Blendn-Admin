import { reachedThroughBuilding, visibleEventsWhere } from "@/lib/event-visibility"
import { hostNotSuspended } from "@/lib/event-access"
import { actorFor } from "@/lib/org-membership"
import { db } from "@/lib/db"

jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: { venues: { findMany: jest.fn() } } }))

const mockActorFor = actorFor as jest.MockedFunction<typeof actorFor>
const mockVenues = db.venues.findMany as unknown as jest.Mock

/**
 * Which events a person may see listed.
 *
 * ## Why this file exists at all
 *
 * `lib/event-visibility.ts`'s own docblock cited this file as "what holds them
 * together" **before it existed**. A test-coverage pass caught it: a comment
 * asserting a guard that is not there is worse than no comment, because the
 * next reader stops checking. That is the eighteenth instance of the pattern
 * this codebase keeps recording, and the first one I wrote this session.
 *
 * ## What it is guarding
 *
 * H2, whose signature nobody reports as a bug: a colleague at the same
 * organisation opens the events list and it is **empty**, because they
 * personally created nothing. `GET /api/events` fixed that once and the
 * dashboard screen kept asking a different way; the module is the fix, and
 * these are the four branches it has to get right.
 */
beforeEach(() => {
  jest.clearAllMocks()
  mockVenues.mockResolvedValue([])
})

describe("visibleEventsWhere", () => {
  it("shows an admin everything that is not deleted, with no scoping at all", async () => {
    const where = await visibleEventsWhere({ id: "admin-1", role: "app_admin" })

    // Venue days are nobody's to list, an admin's included (step 3).
    expect(where).toEqual({ deleted_at: null, kind: "event" })
    // No `OR` — an admin must not be narrowed to what they happened to create.
    expect(where.OR).toBeUndefined()
    // And the membership lookup is skipped entirely, so an admin never pays for it.
    expect(mockActorFor).not.toHaveBeenCalled()
  })

  it("scopes an organiser to their organisations, plus what they created", async () => {
    mockActorFor.mockResolvedValue({ id: "user-1", role: "organizer", orgIds: ["org-1", "org-2"], editOrgIds: ["org-1", "org-2"] })

    const where = await visibleEventsWhere({ id: "user-1", role: "organizer" })

    expect(where).toEqual({
      deleted_at: null,
      kind: "event",
      OR: [
        { organizer_org_id: { in: ["org-1", "org-2"] } },
        { organizer_id: "user-1", organizer_org_id: null, ...hostNotSuspended },
      ],
    })
  })

  it("gives a venue owner the events in their building from its claim on, whoever created them", async () => {
    /*
     * The clause `eventPermissions.canOperate` grants and this list used not to
     * show. A venue owner who has run nothing personally still operates every
     * event at their venue — chat, moderation, the attendee list — so a list
     * that hides those rows contradicts the authorization layer rather than
     * merely being thin.
     */
    mockActorFor.mockResolvedValue({ id: "owner-1", role: "venue_owner", orgIds: ["org-9"], editOrgIds: ["org-9"] })
    const claimedAt = new Date("2026-09-01T00:00:00Z")
    // The second has no claim date: bad data, and it opens nothing (SCRUM-500).
    mockVenues.mockResolvedValue([
      { id: "venue-1", claimed_at: claimedAt },
      { id: "venue-2", claimed_at: null },
    ])

    const where = await visibleEventsWhere({ id: "owner-1", role: "venue_owner" })

    expect(mockVenues).toHaveBeenCalledWith(
      expect.objectContaining({ where: { owner_org_id: { in: ["org-9"] } } })
    )
    expect(where.OR).toEqual([
      { organizer_org_id: { in: ["org-9"] } },
      { venue_id: "venue-1", start_time: { gte: claimedAt } },
      { organizer_id: "owner-1", organizer_org_id: null, ...hostNotSuspended },
    ])
  })

  it("gives an organizer-role member of a venue-owning org that venue's events from the claim, as the resolver does (SCRUM-1246)", async () => {
    // The mirror of the case above: the role is not a fact the list reads.
    const claimedAt = new Date("2026-09-01T00:00:00Z")
    mockActorFor.mockResolvedValue({ id: "user-1", role: "organizer", orgIds: ["org-9"], editOrgIds: ["org-9"] })
    mockVenues.mockResolvedValue([{ id: "venue-1", claimed_at: claimedAt }])
    const where = await visibleEventsWhere({ id: "user-1", role: "organizer" })

    expect(where.OR).toEqual([
      { organizer_org_id: { in: ["org-9"] } },
      { venue_id: "venue-1", start_time: { gte: claimedAt } },
      { organizer_id: "user-1", organizer_org_id: null, ...hostNotSuspended },
    ])
  })

  it("leaves an organiser whose org owns no venue exactly as before", async () => {
    mockActorFor.mockResolvedValue({ id: "user-1", role: "organizer", orgIds: ["org-1"], editOrgIds: ["org-1"] })
    const where = await visibleEventsWhere({ id: "user-1", role: "organizer" })
    expect(where.OR).toEqual([
      { organizer_org_id: { in: ["org-1"] } },
      { organizer_id: "user-1", organizer_org_id: null, ...hostNotSuspended },
    ])
  })

  it("falls back to authorship when somebody belongs to no organisation", async () => {
    /*
     * A1: `organizer_org_id` went unwritten for a long time, so 64% of
     * production events have none. Without this clause the person who created
     * an event would open the list and not find it — which is a worse failure
     * than seeing a row you cannot open, and is why the fallback is here and
     * deliberately NOT in `eventPermissions`.
     */
    mockActorFor.mockResolvedValue({ id: "lonely-1", role: "organizer", orgIds: [], editOrgIds: [] })

    const where = await visibleEventsWhere({ id: "lonely-1", role: "organizer" })

    expect(where.OR).toEqual([{ organizer_id: "lonely-1", organizer_org_id: null, ...hostNotSuspended }])
  })

  it("lists an org's events for any member, whatever User.role says, as the resolver now grants them (SCRUM-1246)", async () => {
    for (const role of ["sponsor", "attendee"] as const) {
      mockActorFor.mockResolvedValue({ id: "m-1", role, orgIds: ["org-1"], editOrgIds: ["org-1"] })
      const where = await visibleEventsWhere({ id: "m-1", role })
      expect(where.OR).toEqual([
        { organizer_org_id: { in: ["org-1"] } },
        { organizer_id: "m-1", organizer_org_id: null, ...hostNotSuspended },
      ])
    }
  })

  it("never drops the deleted_at filter, whatever the role", async () => {
    mockActorFor.mockResolvedValue({ id: "u", role: "organizer", orgIds: ["o"], editOrgIds: ["o"] })

    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"] as const) {
      const where = await visibleEventsWhere({ id: "u", role })
      expect(where.deleted_at).toBeNull()
    }
  })
})

/*
 * Who sees an event's counts held back: anyone who reaches it through the
 * building rather than running it (SCRUM-501). One rule for the list, the
 * exports and the venue page, keyed on what the person runs, not their role.
 */
describe("reachedThroughBuilding", () => {
  const actor = { id: "u1", orgIds: ["org-venue"] }
  const theirs = { organizer_id: "someone", organizer_org_id: "org-host" }
  const ours = { organizer_id: "someone", organizer_org_id: "org-venue" }

  it("holds back another host's event for any non-admin, organizer role included", () => {
    for (const role of ["venue_owner", "organizer", "attendee", "sponsor"] as const) {
      expect(reachedThroughBuilding(role, actor, theirs)).toBe(true)
    }
  })

  it("never for an event their org runs, or one they created", () => {
    expect(reachedThroughBuilding("organizer", actor, ours)).toBe(false)
    expect(reachedThroughBuilding("organizer", actor, { organizer_id: "u1", organizer_org_id: null })).toBe(false)
  })

  it("never for the platform's admin", () => {
    expect(reachedThroughBuilding("app_admin", actor, theirs)).toBe(false)
  })
})
