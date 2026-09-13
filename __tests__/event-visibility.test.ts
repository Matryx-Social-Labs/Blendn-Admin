import { visibleEventsWhere } from "@/lib/event-visibility"
import { actorFor } from "@/lib/org-membership"

jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn() }))

const mockActorFor = actorFor as jest.MockedFunction<typeof actorFor>

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
beforeEach(() => jest.clearAllMocks())

describe("visibleEventsWhere", () => {
  it("shows an admin everything that is not deleted, with no scoping at all", async () => {
    const where = await visibleEventsWhere({ id: "admin-1", role: "app_admin" })

    expect(where).toEqual({ deleted_at: null })
    // No `OR` — an admin must not be narrowed to what they happened to create.
    expect(where.OR).toBeUndefined()
    // And the membership lookup is skipped entirely, so an admin never pays for it.
    expect(mockActorFor).not.toHaveBeenCalled()
  })

  it("scopes an organiser to their organisations, plus what they created", async () => {
    mockActorFor.mockResolvedValue({ id: "user-1", role: "organizer", orgIds: ["org-1", "org-2"] })

    const where = await visibleEventsWhere({ id: "user-1", role: "organizer" })

    expect(where).toEqual({
      deleted_at: null,
      OR: [
        { organizer_org_id: { in: ["org-1", "org-2"] } },
        { organizer_id: "user-1" },
      ],
    })
  })

  it("gives a venue owner the events in their building, whoever created them", async () => {
    /*
     * The clause `eventPermissions.canOperate` grants and this list used not to
     * show. A venue owner who has run nothing personally still operates every
     * event at their venue — chat, moderation, the attendee list — so a list
     * that hides those rows contradicts the authorization layer rather than
     * merely being thin.
     */
    mockActorFor.mockResolvedValue({ id: "owner-1", role: "venue_owner", orgIds: ["org-9"] })

    const where = await visibleEventsWhere({ id: "owner-1", role: "venue_owner" })

    expect(where.OR).toEqual([
      { organizer_org_id: { in: ["org-9"] } },
      { venue: { owner_org_id: { in: ["org-9"] } } },
      { organizer_id: "owner-1" },
    ])
  })

  it("does not give an organiser the venue clause", async () => {
    // The mirror of the case above, and the one that would silently widen
    // access rather than narrow it.
    mockActorFor.mockResolvedValue({ id: "user-1", role: "organizer", orgIds: ["org-9"] })

    const where = await visibleEventsWhere({ id: "user-1", role: "organizer" })

    expect(JSON.stringify(where.OR)).not.toContain("owner_org_id")
  })

  it("falls back to authorship when somebody belongs to no organisation", async () => {
    /*
     * A1: `organizer_org_id` went unwritten for a long time, so 64% of
     * production events have none. Without this clause the person who created
     * an event would open the list and not find it — which is a worse failure
     * than seeing a row you cannot open, and is why the fallback is here and
     * deliberately NOT in `eventPermissions`.
     */
    mockActorFor.mockResolvedValue({ id: "lonely-1", role: "organizer", orgIds: [] })

    const where = await visibleEventsWhere({ id: "lonely-1", role: "organizer" })

    expect(where.OR).toEqual([{ organizer_id: "lonely-1" }])
  })

  it("gives a sponsor nothing but their own authorship, even inside an organising org", async () => {
    /*
     * Found by a security pass, in code I had written that afternoon — and the
     * test above walked straight past it, because it iterated `sponsor` and
     * asserted only `deleted_at`.
     *
     * `eventPermissions` denies a sponsor outright, whatever their memberships.
     * `organisation_members` has no notion of a "sponsor org" versus an
     * "organiser org" — one row can both run events and hold `may_sponsor` — so
     * scoping this list on membership alone showed a sponsor every event their
     * org runs, on a screen the resolver would refuse them row by row.
     *
     * The nav hides Events from sponsors. A nav filter is not an authorization
     * check.
     */
    mockActorFor.mockResolvedValue({ id: "sponsor-1", role: "sponsor", orgIds: ["org-1"] })

    const where = await visibleEventsWhere({ id: "sponsor-1", role: "sponsor" })

    expect(where.OR).toEqual([{ organizer_id: "sponsor-1" }])
    expect(JSON.stringify(where)).not.toContain("organizer_org_id")
  })

  it("never drops the deleted_at filter, whatever the role", async () => {
    mockActorFor.mockResolvedValue({ id: "u", role: "organizer", orgIds: ["o"] })

    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"] as const) {
      const where = await visibleEventsWhere({ id: "u", role })
      expect(where.deleted_at).toBeNull()
    }
  })
})
