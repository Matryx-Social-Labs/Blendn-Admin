import { renderToStaticMarkup } from "react-dom/server"

/*
 * "Your access to this event", the Overview's last panel (SCRUM-1446).
 *
 * It is drawn for whoever may operate an event but not edit it, and it was
 * written when that meant one thing: the venue the event is held at. Org staff
 * (SCRUM-1244) and a venue's own daily room reach it too. Both were told
 * "It is running at «venue», so you get … the attendee count" and offered an
 * Attendees button that is not one of their tabs, so it redirected them back
 * to the page they were on.
 *
 * Driven through the page with the real resolver, so the rows below are the
 * permissions a real actor gets, not booleans typed into a component.
 */

type Actor = { orgIds: string[]; editOrgIds: string[] }
const mockSession = { user: { id: "u1", role: "organizer" } }
let mockActor: Actor = { orgIds: [], editOrgIds: [] }
let mockEvent: Record<string, unknown> = {}
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))
jest.mock("@/lib/org-membership", () => ({
  actorFor: (user: { id: string; role: string }) => Promise.resolve({ ...user, ...mockActor }),
  resolveSponsorGrant: () => Promise.resolve(null),
}))
jest.mock("@/lib/db", () => ({
  db: { events: { findFirst: () => Promise.resolve({ ...mockEvent }) } },
}))
jest.mock("@/lib/attendee-roster", () => ({ eventAttendees: jest.fn() }))
jest.mock("@/lib/event-issues", () => ({ issuesFor: jest.fn() }))
jest.mock("@/lib/attendance", () => ({ getEventAttendance: jest.fn() }))
jest.mock("@/lib/event-insights", () => ({ eventInsights: jest.fn() }))
jest.mock("@/lib/feedback-digest", () => ({ buildFeedbackDigest: jest.fn() }))
jest.mock("@/lib/event-overview", () => ({
  getEventOverview: () =>
    Promise.resolve({ state: "live", hero: { label: "In the room", value: "42", hint: "" }, tiles: [], blockers: [], publishable: true }),
}))
jest.mock("@/lib/check-in-refusals", () => ({ eventRefusals: jest.fn(), refusalSummary: jest.fn() }))
jest.mock("@/components/dashboard/live-tab", () => ({ LiveTab: () => null }))
jest.mock("@/components/event-messaging", () => ({ EventMessaging: () => null }))
jest.mock("@/components/event-sponsors", () => ({ EventSponsors: () => null }))
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))
jest.mock("@/app/dashboard/events/[id]/issue-actions", () => ({ acknowledgeIssue: jest.fn() }))

import EventDetailPage from "@/app/dashboard/events/[id]/page"

const HOST = "org-host"
const VENUE = "org-venue"
// Worst-case names (long-text rule): both must arrive whole, and wrap rather than truncate.
const ORG_NAME = "The Thiruvananthapuram Late-Night Founders & Filter Coffee Collective"
const VENUE_NAME = "Saint-Jean-sur-Richelieu Riverside Brewing Company Taproom & Kitchen"
const esc = (s: string) => s.replace(/&/g, "&amp;")

const HOUR = 3_600_000
const running = { start_time: new Date(Date.now() - HOUR), end_time: new Date(Date.now() + 2 * HOUR) }

function eventRow(fields: Record<string, unknown> = {}) {
  return {
    id: "e1",
    title: "Founders & Filter Coffee",
    status: "published",
    kind: "event",
    created_at: new Date("2026-09-01T10:00:00Z"),
    timezone: "Asia/Kolkata",
    venue_name: null,
    city: "Bengaluru",
    organizer_id: "someone-else",
    ticketing_mode: null,
    curated_at: null,
    claimed_at: null,
    organizer_org_id: HOST,
    organizer_org: { name: ORG_NAME },
    venue: { name: VENUE_NAME, owner_org_id: VENUE, claimed_at: new Date("2026-01-01T00:00:00Z") },
    ...running,
    ...fields,
  }
}

/** The page, and the access panel cut out of it: the tabs above carry their own links. */
async function render() {
  const page = await EventDetailPage({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve({}) })
  const html = renderToStaticMarkup(page)
  const at = html.indexOf("Your access to this event")
  return { html, panel: at === -1 ? null : html.slice(at) }
}

beforeEach(() => {
  mockEvent = eventRow()
})

describe("Your access to this event: one row per state", () => {
  it("an owner or admin of the organizing org gets no panel: nothing is missing for them", async () => {
    mockActor = { orgIds: [HOST], editOrgIds: [HOST] }
    const { html, panel } = await render()
    expect(html).toContain("In the room")
    expect(panel).toBeNull()
  })

  it("a venue member is told it runs at their venue, with Attendees (the held-back count) and Room chat", async () => {
    mockActor = { orgIds: [VENUE], editOrgIds: [VENUE] }
    const { panel } = await render()
    expect(panel).toContain(`It is running at <b>${esc(VENUE_NAME)}</b>, so you get the live view, the attendee count and the room chat.`)
    expect(panel).toContain('href="/dashboard/events/e1?tab=attendees"')
    expect(panel).toContain('href="/dashboard/events/e1/messaging"')
    expect(panel).not.toContain("on the team at")
  })

  it("org staff are told whose team they are on, and get Room chat but no Attendees button that bounces", async () => {
    mockActor = { orgIds: [HOST], editOrgIds: [] }
    const { panel } = await render()
    expect(panel).toContain(
      `You are on the team at <b>${esc(ORG_NAME)}</b>, so you get the live view and the room chat. Editing, publishing and cancelling, and the attendee list, belong to its owners and admins.`
    )
    expect(panel).not.toContain("tab=attendees")
    expect(panel).not.toContain("It is running at")
    expect(panel).toContain('href="/dashboard/events/e1/messaging"')
  })

  it("staff of the organizing org who are also in the venue's org get the venue's row, as the resolver says", async () => {
    mockActor = { orgIds: [HOST, VENUE], editOrgIds: [VENUE] }
    const { panel } = await render()
    expect(panel).toContain("It is running at")
    expect(panel).toContain('href="/dashboard/events/e1?tab=attendees"')
  })

  it("a venue member on their venue day is not promised an attendee count, and gets no Attendees button", async () => {
    mockActor = { orgIds: [VENUE], editOrgIds: [VENUE] }
    mockEvent = eventRow({ kind: "venue_day", organizer_org_id: null, organizer_org: null })
    const { panel } = await render()
    expect(panel).toContain(
      `This is the room for the day at <b>${esc(VENUE_NAME)}</b>, so you get the live view and the room chat to moderate it. The venue is never shown who was in it.`
    )
    expect(panel).not.toContain("attendee count")
    expect(panel).not.toContain("tab=attendees")
    expect(panel).toContain('href="/dashboard/events/e1/messaging"')
  })

  it("wraps a long name instead of cutting it: the sentence carries no truncation", async () => {
    mockActor = { orgIds: [HOST], editOrgIds: [] }
    const { panel } = await render()
    const sentence = panel!.slice(0, panel!.indexOf("</p>"))
    expect(sentence).not.toMatch(/truncate|line-clamp|text-ellipsis/)
  })
})
