/*
 * A sponsor placement's lifecycle, and the three ways out of it that did not
 * exist.
 *
 *   - `cancelled` was a trap. `@@unique([event_id, sponsor_id])` means a
 *     cancelled row still occupies the pair, and `attachSponsorToEvent` did a
 *     bare `create` — so removing a brand and changing your mind threw a raw
 *     P2002 about a constraint rather than a message about the brand. The only
 *     escape was an admin deleting the row by hand.
 *   - `removePlacement` hard-deleted a placement with no campaigns, and
 *     `placement_charges.placement` is `onDelete: Restrict` — so a placement
 *     that was PRICED but never had copy written died on the foreign key. That
 *     is the ordinary order of events: a fee is agreed before anybody writes
 *     the ad.
 *   - `createUnclaimedSponsor` checked authentication and nothing else, so any
 *     signed-in dashboard user could mint a brand row.
 *
 * Not in `negative-controls.json`: that registry tracks STRUCTURAL guards — the
 * ones that scan source text and can pass vacuously against broken code. These
 * exercise behaviour through mocks, so they cannot silently match nothing. The
 * controls were run anyway, because a test nobody has broken on purpose is a
 * test nobody has checked:
 *
 *   - replacing the `placement_charges` count with `0` fails "cancels rather
 *     than deletes when a charge exists"
 *   - deleting the `prior.status !== "cancelled"` guard fails "refuses to
 *     silently reset a live placement"
 */

const mockDb = {
  events: { findUnique: jest.fn() },
  sponsors: { findFirst: jest.fn(), create: jest.fn() },
  event_sponsors: {
    count: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  event_sponsored_messages: { count: jest.fn() },
  placement_charges: { count: jest.fn() },
}

const mockAuth = jest.fn()
const mockPerms = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/org-membership", () => ({ actorFor: async () => ({ orgIds: ["org-1"] }) }))
jest.mock("@/lib/rbac", () => ({
  eventPermissions: () => mockPerms(),
  eventPermissionSelect: {},
}))

import { attachSponsorToEvent, removePlacement } from "@/lib/sponsor-actions"

const EVENT = "11111111-1111-4111-8111-111111111111"
const SPONSOR = "22222222-2222-4222-8222-222222222222"
const PLACEMENT = "33333333-3333-4333-8333-333333333333"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
  mockPerms.mockReturnValue({ canEdit: true, canOperate: true })
  mockDb.events.findUnique.mockResolvedValue({ id: EVENT })
  mockDb.sponsors.findFirst.mockResolvedValue({ id: SPONSOR, name: "Blue Tokai", org_id: null })
  mockDb.event_sponsors.count.mockResolvedValue(0)
  mockDb.event_sponsors.findUnique.mockResolvedValue(null)
  mockDb.event_sponsors.upsert.mockResolvedValue({ id: PLACEMENT, status: "approved" })
})

describe("a cancelled placement can be brought back", () => {
  it("revives the existing row rather than creating a second", async () => {
    mockDb.event_sponsors.findUnique.mockResolvedValue({ status: "cancelled" })

    await attachSponsorToEvent(EVENT, SPONSOR)

    const call = mockDb.event_sponsors.upsert.mock.calls[0][0]
    expect(call.where).toEqual({
      event_id_sponsor_id: { event_id: EVENT, sponsor_id: SPONSOR },
    })
    /*
     * Reviving rather than deleting and recreating keeps `created_by` — who
     * first brought this brand to this event — and stops the audit trail
     * gaining a creation that did not happen.
     */
    expect(call.update.status).toBe("approved")
  })

  it("clears a stale decision when the revival is not itself one", async () => {
    // A proposed placement carrying the previous cancellation's `decided_by`
    // would read as though somebody had already approved it.
    mockDb.sponsors.findFirst.mockResolvedValue({ id: SPONSOR, name: "Beta", org_id: "org-9" })
    mockDb.event_sponsors.findUnique.mockResolvedValue({ status: "cancelled" })
    mockDb.event_sponsors.upsert.mockResolvedValue({ id: PLACEMENT, status: "proposed" })

    await attachSponsorToEvent(EVENT, SPONSOR)

    const { update } = mockDb.event_sponsors.upsert.mock.calls[0][0]
    expect(update.status).toBe("proposed")
    expect(update.decided_by).toBeNull()
    expect(update.decided_at).toBeNull()
  })

  it("refuses to silently reset a live placement", async () => {
    /*
     * The hazard the upsert introduces if left unguarded: re-attaching an
     * already-approved brand would push it back to `proposed`, undoing a
     * decision nobody asked to undo.
     */
    mockDb.event_sponsors.findUnique.mockResolvedValue({ status: "approved" })

    await expect(attachSponsorToEvent(EVENT, SPONSOR)).rejects.toThrow("already on this event")
    expect(mockDb.event_sponsors.upsert).not.toHaveBeenCalled()
  })
})

describe("removing a placement", () => {
  it("cancels rather than deletes when a charge exists", async () => {
    // `placement_charges.placement` is onDelete: Restrict, so the delete branch
    // died on the foreign key for any placement that had been priced.
    mockDb.event_sponsors.findUnique.mockResolvedValue({
      id: PLACEMENT,
      event_id: EVENT,
      sponsor_id: SPONSOR,
      event: {},
    })
    mockDb.event_sponsored_messages.count.mockResolvedValue(0)
    mockDb.placement_charges.count.mockResolvedValue(1)

    await removePlacement(PLACEMENT)

    expect(mockDb.event_sponsors.delete).not.toHaveBeenCalled()
    expect(mockDb.event_sponsors.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) })
    )
  })

  it("still deletes one with no history at all", async () => {
    mockDb.event_sponsors.findUnique.mockResolvedValue({
      id: PLACEMENT,
      event_id: EVENT,
      sponsor_id: SPONSOR,
      event: {},
    })
    mockDb.event_sponsored_messages.count.mockResolvedValue(0)
    mockDb.placement_charges.count.mockResolvedValue(0)

    await removePlacement(PLACEMENT)

    expect(mockDb.event_sponsors.delete).toHaveBeenCalled()
    expect(mockDb.event_sponsors.update).not.toHaveBeenCalled()
  })
})

describe("who may create a brand", () => {
  it("refuses somebody with no claim on the event", async () => {
    /*
     * Organisation-shaped, not role-shaped. A role check would have let an
     * organiser with no claim on THIS event create brands against it — and
     * because the name check is global, take a name every other org is then
     * told to "pick from the list".
     */
    const { createUnclaimedSponsor } = await import("@/lib/sponsor-actions")
    mockPerms.mockReturnValue({ canEdit: false, canOperate: false })

    await expect(
      createUnclaimedSponsor(EVENT, { name: "Squatted Brand" })
    ).rejects.toThrow("Forbidden")
    expect(mockDb.sponsors.create).not.toHaveBeenCalled()
  })
})
