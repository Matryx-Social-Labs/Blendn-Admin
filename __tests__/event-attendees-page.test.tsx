import { renderToStaticMarkup } from "react-dom/server"

import type { EventAttendees } from "@/lib/attendee-roster"

/*
 * The event page's Attendees tab is wired to the roster, both ways (SCRUM-499).
 *
 * The tab used to redirect to `/messaging?view=attendees`, which nothing read.
 * This renders the page itself, with the session, the event and the roster
 * mocked, and asserts what each kind of caller is shown: the label table for
 * whoever runs the event, the count for the venue, and no redirect for either.
 * What the roster contains is `integration/event-attendee-roster.itest.ts`'s.
 */

const mockSession = { user: { id: "u1", role: "organizer" } }
let mockOrg = "org-a"
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))
jest.mock("@/lib/org-membership", () => ({
  actorFor: (user: { id: string; role: string }) => Promise.resolve({ ...user, orgIds: ["org-a"] }),
}))
jest.mock("@/lib/db", () => ({
  db: {
    events: {
      findFirst: () =>
        Promise.resolve({
          id: "e1",
          title: "Founders & Filter Coffee",
          status: "published",
          created_at: new Date("2026-09-01T10:00:00Z"),
          start_time: new Date("2026-09-20T13:00:00Z"),
          end_time: new Date("2026-09-20T16:00:00Z"),
          timezone: "Asia/Kolkata",
          venue_name: null,
          city: "Bengaluru",
          organizer_id: "u1",
          kind: "event",
          organizer_org_id: mockOrg,
          venue: { name: "The Humming Tree", owner_org_id: "org-a", claimed_at: new Date("2026-01-01T00:00:00Z") },
          curated_by: null,
          claimed_at: null,
        }),
    },
  },
}))
let mockAttendees: EventAttendees | null = null
const mockEventAttendees = jest.fn((..._args: unknown[]) => Promise.resolve(mockAttendees))
jest.mock("@/lib/attendee-roster", () => ({ eventAttendees: (...args: unknown[]) => mockEventAttendees(...args) }))

// The page imports these at module level; the Attendees tab never calls them.
jest.mock("@/lib/event-issues", () => ({ issuesFor: jest.fn() }))
jest.mock("@/lib/attendance", () => ({ getEventAttendance: jest.fn() }))
jest.mock("@/lib/connection-metrics", () => ({ getConnectionMetrics: jest.fn() }))
jest.mock("@/lib/event-overview", () => ({ getEventOverview: jest.fn() }))
jest.mock("@/lib/check-in-refusals", () => ({ eventRefusals: jest.fn(), refusalSummary: jest.fn() }))
jest.mock("@/components/dashboard/live-tab", () => ({ LiveTab: () => null }))
// Needs a mounted app router; it is the venue link in the header, not the tab.
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))

import EventDetailPage from "@/app/dashboard/events/[id]/page"

async function render() {
  const page = await EventDetailPage({
    params: Promise.resolve({ id: "e1" }),
    searchParams: Promise.resolve({ tab: "attendees" }),
  })
  return renderToStaticMarkup(page)
}

beforeEach(() => {
  mockEventAttendees.mockClear()
  mockOrg = "org-a"
  mockSession.user.role = "organizer"
})

it("renders the label table for whoever runs the event, and does not redirect", async () => {
  mockAttendees = {
    view: "labels",
    rows: [{ id: "attendee-0123456789ab", rsvp: "going", arrivedAt: "2026-09-20T13:15:00.000Z", status: "came" }],
    came: 1,
    walkIns: 0,
    noShows: 0,
  }
  const html = await render()
  expect(mockEventAttendees).toHaveBeenCalledWith(expect.objectContaining({ id: "u1", orgIds: ["org-a"] }), "e1", expect.any(Date))
  expect(html).toContain('aria-label="Attendees of this event"')
  expect(html).toContain("attendee-0123456789ab")
  // 13:15Z on Kolkata's clock, as a quarter-hour window.
  expect(html).toContain("18:45–19:00")
  expect(html).not.toContain(">Came<")
})

it("renders the count for the venue, with no table", async () => {
  // The event is another organisation's, held at the caller's venue.
  mockOrg = "org-b"
  mockSession.user.role = "venue_owner"
  mockAttendees = { view: "count", started: true, came: 12 }
  const html = await render()
  expect(html).toMatch(/Came/)
  expect(html).toContain(">12<")
  expect(html).not.toContain("<table")
  expect(html).not.toMatch(/attendee-[0-9a-f]{12}/)
})

it("is a 404, not somebody else's list, when the roster refuses", async () => {
  mockAttendees = null
  await expect(render()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/)
})
