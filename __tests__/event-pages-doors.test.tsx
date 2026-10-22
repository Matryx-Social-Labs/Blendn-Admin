import { renderToStaticMarkup } from "react-dom/server"

/*
 * Who gets through which door under one event (step 15 review).
 *
 * The overview, Room chat and Feedback load through one loader: a missing
 * event is a 404 and an event the viewer may not operate sends them to the
 * events list. Then each tab asks its own question again, because a URL is not
 * a tab list: the QR & link tab is the host's, for a published event that is
 * not a venue day; Feedback exists once the night is over, never on a venue
 * day.
 */

const mockSession = { user: { id: "u1", role: "organizer" } }
type MockEvent = {
  status: string
  kind: string
  start_time: Date
  end_time: Date
  organizer_org_id: string
} | null
let mockEvent: MockEvent = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))
jest.mock("@/lib/org-membership", () => ({
  actorFor: (user: { id: string; role: string }) => Promise.resolve({ ...user, orgIds: ["org-a"] }),
  resolveSponsorGrant: () => Promise.resolve(null),
}))
jest.mock("@/lib/db", () => ({
  db: {
    events: {
      findFirst: () =>
        Promise.resolve(
          mockEvent && {
            id: "e1",
            title: "Founders & Filter Coffee",
            created_at: new Date("2026-09-01T10:00:00Z"),
            timezone: "Asia/Kolkata",
            venue_name: null,
            city: "Bengaluru",
            organizer_id: "someone-else",
            venue: { name: "The Humming Tree", owner_org_id: "org-a", claimed_at: new Date("2026-01-01T00:00:00Z") },
            curated_at: null,
            claimed_at: null,
            ...mockEvent,
          }
        ),
    },
  },
}))
jest.mock("@/lib/feedback-digest", () => ({ buildFeedbackDigest: jest.fn() }))
// The page imports these at module level; none of these doors reaches them.
jest.mock("@/lib/attendee-roster", () => ({ eventAttendees: jest.fn() }))
jest.mock("@/lib/event-issues", () => ({ issuesFor: jest.fn() }))
jest.mock("@/lib/attendance", () => ({ getEventAttendance: jest.fn() }))
jest.mock("@/lib/connection-metrics", () => ({ getConnectionMetrics: jest.fn() }))
jest.mock("@/lib/event-overview", () => ({ getEventOverview: jest.fn() }))
jest.mock("@/lib/check-in-refusals", () => ({ eventRefusals: jest.fn(), refusalSummary: jest.fn() }))
jest.mock("@/components/dashboard/live-tab", () => ({ LiveTab: () => null }))
jest.mock("@/components/event-messaging", () => ({ EventMessaging: () => null }))
jest.mock("@/components/event-sponsors", () => ({ EventSponsors: () => null }))
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))
jest.mock("@/app/dashboard/events/[id]/feedback/feedback-feed", () => ({ FeedbackFeed: () => null }))

import EventDetailPage from "@/app/dashboard/events/[id]/page"
import FeedbackPage from "@/app/dashboard/events/[id]/feedback/page"

const DAY = 86_400_000
const ahead = { start_time: new Date(Date.now() + 2 * DAY), end_time: new Date(Date.now() + 2 * DAY + 3_600_000) }
const over = { start_time: new Date(Date.now() - 2 * DAY), end_time: new Date(Date.now() - 2 * DAY + 3_600_000) }

/** The thrown digest of `redirect()` / `notFound()`, or "rendered". */
async function door(page: Promise<React.ReactElement>): Promise<string> {
  try {
    renderToStaticMarkup(await page)
    return "rendered"
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? String(err)
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`
    if (/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(digest)) return "404"
    throw err
  }
}

const share = () => EventDetailPage({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve({ tab: "share" }) })
const feedback = () => FeedbackPage({ params: Promise.resolve({ id: "e1" }) })

beforeEach(() => {
  mockSession.user.role = "organizer"
  mockEvent = null
})

describe("the loader's doors", () => {
  it("is a 404 for an event that is not there, on the overview and on Feedback", async () => {
    expect(await door(share())).toBe("404")
    expect(await door(feedback())).toBe("404")
  })

  it("sends somebody who may not operate the event to the events list", async () => {
    // Another organisation's night, at a venue this organiser does not own.
    mockSession.user.role = "organizer"
    mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-z" }
    jest.requireMock("@/lib/db").db.events.findFirst = () =>
      Promise.resolve({ ...baseRow(), ...mockEvent, venue: null })
    expect(await door(feedback())).toBe("redirect /dashboard/events")
    expect(await door(share())).toBe("redirect /dashboard/events")
    restoreFindFirst()
  })
})

describe("the QR & link tab", () => {
  it("opens for the host of a published event", async () => {
    mockEvent = { status: "published", kind: "event", ...ahead, organizer_org_id: "org-a" }
    expect(await door(share())).toBe("rendered")
  })

  it.each(["draft", "cancelled", "completed"])("sends a %s event back to its overview", async (status) => {
    mockEvent = { status, kind: "event", ...ahead, organizer_org_id: "org-a" }
    expect(await door(share())).toBe("redirect /dashboard/events/e1")
  })

  it("sends a venue day back to its overview", async () => {
    mockSession.user.role = "venue_owner"
    mockEvent = { status: "published", kind: "venue_day", ...ahead, organizer_org_id: "org-sys" }
    expect(await door(share())).toBe("redirect /dashboard/events/e1")
  })

  it("is not the venue owner's on another host's night", async () => {
    mockSession.user.role = "venue_owner"
    mockEvent = { status: "published", kind: "event", ...ahead, organizer_org_id: "org-b" }
    expect(await door(share())).toBe("redirect /dashboard/events/e1")
  })
})

describe("the Feedback tab's page", () => {
  it("renders once the night is over", async () => {
    mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-a" }
    jest.requireMock("@/lib/feedback-digest").buildFeedbackDigest.mockResolvedValue(emptyDigest())
    expect(await door(feedback())).toBe("rendered")
  })

  it("sends a night still ahead back to its overview", async () => {
    mockEvent = { status: "published", kind: "event", ...ahead, organizer_org_id: "org-a" }
    expect(await door(feedback())).toBe("redirect /dashboard/events/e1")
  })

  it("sends a venue day back to its overview, over or not", async () => {
    mockSession.user.role = "venue_owner"
    mockEvent = { status: "published", kind: "venue_day", ...over, organizer_org_id: "org-sys" }
    expect(await door(feedback())).toBe("redirect /dashboard/events/e1")
  })

  it("builds a venue's digest as the venue's, and the host's as the host's", async () => {
    const build = jest.requireMock("@/lib/feedback-digest").buildFeedbackDigest as jest.Mock
    build.mockResolvedValue(emptyDigest())
    mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-a" }
    await door(feedback())
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ id: "e1" }), "host")
    mockSession.user.role = "venue_owner"
    mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-b" }
    await door(feedback())
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ id: "e1" }), "venue")
  })
})

function baseRow() {
  return {
    id: "e1",
    title: "Founders & Filter Coffee",
    created_at: new Date("2026-09-01T10:00:00Z"),
    timezone: "Asia/Kolkata",
    venue_name: null,
    city: "Bengaluru",
    organizer_id: "someone-else",
    curated_at: null,
    claimed_at: null,
  }
}

const originalFindFirst = jest.requireMock("@/lib/db").db.events.findFirst
function restoreFindFirst() {
  jest.requireMock("@/lib/db").db.events.findFirst = originalFindFirst
}

function emptyDigest() {
  return {
    view: "host",
    eventTitle: "Founders & Filter Coffee",
    endedAt: over.end_time.toISOString(),
    timezone: "Asia/Kolkata",
    ended: true,
    windowClosesAt: over.end_time.toISOString(),
    windowOpen: false,
    counts: { positive: 0, neutral: 0, negative: 0 },
    total: 0,
    categories: [],
    ratings: [0, 0, 0, 0, 0],
    averageRating: null,
    ratingCount: 0,
    messages: [],
  }
}
