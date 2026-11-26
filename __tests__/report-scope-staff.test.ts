const mockDb = { organisation_members: { findMany: jest.fn() } }
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/event-visibility", () => ({ claimedVenueEventsWhere: jest.fn(async () => []), hostsEvent: jest.fn() }))

import { reportScope } from "@/lib/reports"

/**
 * The reports and the organisation's audience (`attendeeRoster`, through
 * `eventScopeFor`) are per-guest rows: the roster in another shape. An org's
 * `staff` member operates its nights and never reads its roster (SCRUM-1244),
 * so the hosted arm is the orgs they own or administer, not every org they
 * are in. Owners and admins keep their reports.
 */
const scopeAs = async (role: "owner" | "admin" | "staff") => {
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: "org-host", role }])
  const { hosted, all } = await reportScope("organizer", "u1")
  return { hosted: JSON.stringify(hosted), all: JSON.stringify(all) }
}

it("gives an org's owner and admin its events to report on", async () => {
  expect((await scopeAs("owner")).hosted).toContain("org-host")
  expect((await scopeAs("admin")).hosted).toContain("org-host")
})

it("gives an org's staff member none of its events to report on, nor its audience (SCRUM-1244)", async () => {
  const staff = await scopeAs("staff")
  expect(staff.hosted).not.toContain("org-host")
  expect(staff.all).not.toContain("org-host")
})

it("does not count a staff member who also owns the venue's org as the night's host (SCRUM-1244)", async () => {
  mockDb.organisation_members.findMany.mockResolvedValue([
    { org_id: "org-host", role: "staff" },
    { org_id: "org-venue", role: "owner" },
  ])
  const { actor } = await reportScope("venue_owner", "u1")
  // `hostsEvent(actor, …)` reads these: the host org is not among them, so the venue's figures are held back.
  expect(actor.orgIds).toEqual(["org-venue"])
})

it("gives an organizer-role member of a venue-owning org the venue's events, not only a venue_owner (SCRUM-1246)", async () => {
  const { claimedVenueEventsWhere } = jest.requireMock("@/lib/event-visibility") as { claimedVenueEventsWhere: jest.Mock }
  claimedVenueEventsWhere.mockResolvedValueOnce([{ venue_id: "venue-1", start_time: { gte: new Date(0) } }])
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: "org-venue", role: "owner" }])
  const { all, venueOnly } = await reportScope("organizer", "u1")
  expect(JSON.stringify(all)).toContain("venue-1")
  expect(JSON.stringify(venueOnly)).toContain("venue-1")
})
