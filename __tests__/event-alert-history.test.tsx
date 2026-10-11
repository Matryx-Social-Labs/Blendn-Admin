import { renderToStaticMarkup } from "react-dom/server"

/*
 * The alert log, once the event is over (F6).
 *
 * `event_issues` records what the room's watch saw while it ran, and the Live
 * tab was the only reader. The tab exists only while the event runs
 * (`eventTabsFor`), so the morning after, when "did anything go wrong" is
 * actually asked, the record had no screen: `?tab=live` redirects to the
 * overview, and the Live tab's own "The event has ended" branch never listed it.
 * It is a panel on the Overview now, for an event that is over.
 *
 * Hosts see counts in the bodies; a venue on another host's night gets the same
 * alerts as figure-free sentences, and two it is never sent (`alertsForVenue`).
 * Nothing here carries a person: titles and bodies are counts and conditions.
 */

const mockSession = { user: { id: "u1", role: "organizer" } }
let mockEvent: { status: string; kind: string; start_time: Date; end_time: Date; organizer_org_id: string } | null = null
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
// The row's "Mark as seen" is a server action; the page never runs it.
jest.mock("@/app/dashboard/events/[id]/issue-actions", () => ({ acknowledgeIssue: jest.fn() }))

import EventDetailPage from "@/app/dashboard/events/[id]/page"
import { IssueLog } from "@/components/dashboard/issue-log"

const DAY = 86_400_000
const over = { start_time: new Date(Date.now() - 2 * DAY), end_time: new Date(Date.now() - 2 * DAY + 3 * 3_600_000) }
const live = { start_time: new Date(Date.now() - 3_600_000), end_time: new Date(Date.now() + 3_600_000) }

const issuesFor = () => jest.requireMock("@/lib/event-issues").issuesFor as jest.Mock
const overviewFor = () => jest.requireMock("@/lib/event-overview").getEventOverview as jest.Mock

const HOUR = 3_600_000
const row = (fields: Partial<Record<string, unknown>>) => ({
  id: "i",
  kind: "over_capacity",
  severity: "critical",
  title: "Over capacity",
  body: "132 inside against a capacity of 120",
  openedAt: new Date(over.start_time.getTime() + HOUR).toISOString(),
  lastSeenAt: new Date(over.start_time.getTime() + HOUR + 20 * 60_000).toISOString(),
  resolvedAt: new Date(over.start_time.getTime() + HOUR + 20 * 60_000).toISOString(),
  acknowledgedAt: null,
  ...fields,
})

const HOST_ROWS = [
  row({ id: "a", kind: "over_capacity" }),
  row({
    id: "b",
    kind: "leaving_early",
    severity: "warning",
    title: "Leaving early",
    body: "7 of 18 have checked out",
    resolvedAt: null,
    openedAt: new Date(over.start_time.getTime() + 2 * HOUR).toISOString(),
    lastSeenAt: new Date(over.start_time.getTime() + 2 * HOUR + 40 * 60_000).toISOString(),
  }),
]

async function overview() {
  const page = await EventDetailPage({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve({}) })
  return renderToStaticMarkup(page)
}

function overviewOf(state: "over" | "live" | "upcoming") {
  return { state, hero: { label: "Turn-up", value: "80%", hint: "" }, tiles: [], blockers: [], publishable: true }
}

beforeEach(() => {
  mockSession.user.role = "organizer"
  mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-a" }
  issuesFor().mockReset().mockResolvedValue(HOST_ROWS)
  overviewFor().mockReset().mockResolvedValue(overviewOf("over"))
})

describe("Alert history, on the Overview of an event that is over", () => {
  it("lists what the room's watch recorded, how each ended, and says nothing is ongoing", async () => {
    const html = await overview()
    expect(html).toContain("Alert history")
    expect(html).toContain("Over capacity")
    expect(html).toContain("132 inside against a capacity of 120")
    expect(html).toContain("Leaving early")
    expect(html).toContain("7 of 18 have checked out")
    expect(html).toMatch(/lasted 20 min/)
    // The one the event ended on: still on, not "ongoing" and not "cleared".
    expect(html).toMatch(/still on when it ended/)
    expect(html).not.toMatch(/ongoing/)
    expect(html).not.toMatch(/tonight/i)
  })

  it("asks for the history of this event, and only when it is over", async () => {
    await overview()
    expect(issuesFor()).toHaveBeenCalledWith("e1")

    issuesFor().mockClear()
    mockEvent = { status: "published", kind: "event", ...live, organizer_org_id: "org-a" }
    overviewFor().mockResolvedValue(overviewOf("live"))
    expect(await overview()).not.toContain("Alert history")
    expect(issuesFor()).not.toHaveBeenCalled()
  })

  it("is not drawn for an event that recorded nothing", async () => {
    issuesFor().mockResolvedValue([])
    expect(await overview()).not.toContain("Alert history")
  })

  it("reads an event that was cancelled after it had alerts, as over", async () => {
    mockEvent = { status: "cancelled", kind: "event", ...over, organizer_org_id: "org-a" }
    expect(await overview()).toContain("Alert history")
  })

  it("gives a venue on another host's night the same alerts as sentences with no figure, and drops the two it is never sent", async () => {
    mockSession.user.role = "venue_owner"
    mockEvent = { status: "published", kind: "event", ...over, organizer_org_id: "org-b" }
    const html = await overview()
    expect(html).toContain("Alert history")
    expect(html).toContain("More guests than the event&#x27;s stated capacity.")
    expect(html).not.toContain("132")
    expect(html).not.toContain("120")
    expect(html).not.toContain("Leaving early")
    expect(html).not.toContain("7 of 18")
  })

  it("is never read for somebody who may not operate the event: the loader sends them away first", async () => {
    // Another organisation's night, at a venue this organiser does not own.
    const db = jest.requireMock("@/lib/db").db
    const keep = db.events.findFirst
    db.events.findFirst = () =>
      Promise.resolve({
        id: "e1",
        title: "x",
        created_at: new Date("2026-09-01T10:00:00Z"),
        timezone: "Asia/Kolkata",
        venue_name: null,
        city: "Bengaluru",
        organizer_id: "someone-else",
        venue: null,
        curated_at: null,
        claimed_at: null,
        status: "published",
        kind: "event",
        ...over,
        organizer_org_id: "org-z",
      })
    try {
      await expect(overview()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") })
      expect(issuesFor()).not.toHaveBeenCalled()
    } finally {
      db.events.findFirst = keep
    }
  })
})

describe("the log, as a feed and as a record", () => {
  const render = (over: boolean, issues = HOST_ROWS) =>
    renderToStaticMarkup(<IssueLog issues={issues as never} timezone="Asia/Kolkata" over={over} />)

  it("says an open one is ongoing while the event runs", () => {
    expect(render(false)).toMatch(/ongoing 40 min/)
    expect(render(false)).not.toMatch(/still on when it ended/)
  })

  it("says it was on when the event ended, and for at least how long, once it is over", () => {
    expect(render(true)).toMatch(/still on when it ended, for at least 40 min/)
  })

  it("draws the record as rows divided by a rule, not a box per row inside the panel's own box", () => {
    expect(render(true)).toContain("divide-y")
    expect(render(true)).not.toContain("rounded-lg border")
    expect(render(false)).toContain("rounded-lg border")
  })

  it("says how bad each was to a screen reader as well as to the eye", () => {
    const html = render(true)
    expect(html).toMatch(/sr-only">Critical: <\/span>Over capacity/)
    expect(html).toMatch(/sr-only">Warning: <\/span>Leaving early/)
  })

  it("keeps the two empty states apart", () => {
    expect(render(false, [])).toContain("Nothing has gone wrong tonight")
    expect(render(true, [])).toContain("No alerts were recorded while it ran.")
    expect(render(true, [])).not.toMatch(/tonight/i)
  })
})

describe("the Live tab, if it is open when the event ends", () => {
  const { LiveTab } = jest.requireActual("@/components/dashboard/live-tab") as typeof import("@/components/dashboard/live-tab")
  const ended = (issues: unknown[]) =>
    renderToStaticMarkup(
      <LiveTab
        eventId="e1"
        startAt={over.start_time.toISOString()}
        endAt={over.end_time.toISOString()}
        timezone="Asia/Kolkata"
        issues={issues as never}
      />
    )

  it("says where the alerts it recorded went, when it recorded any", () => {
    const html = ended(HOST_ROWS)
    expect(html).toContain("The event has ended")
    expect(html).toContain('href="/dashboard/events/e1"')
    expect(html).toContain("See the alert history")
  })

  it("points at nothing when there is nothing to find", () => {
    expect(ended([])).not.toContain("See the alert history")
  })
})
