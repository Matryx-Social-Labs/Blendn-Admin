import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// Needs a mounted app router; it is the organiser's venue link in the header.
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))

import { renderToStaticMarkup } from "react-dom/server"

import EventDetailPage from "@/app/dashboard/events/[id]/page"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * A venue's Overview holds back what its Attendees tab holds back.
 *
 * The Attendees tab gave a venue owner "Came —, held back" for a three-person
 * night, and the Overview one click away printed "Came 3", "Checked in 3", the
 * turn-up and the day-by-day newcomers. A floor on one tab means nothing while
 * the next tab prints the figure (PR #601 review).
 *
 * Rendered from the page itself, against real Postgres, because the leak was
 * in what the page chose to pass down, not in any one query. The organiser's
 * render of the same event is the control: it must print the 3, or "no 3 for
 * the venue" proves nothing.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

const HOUR = 3_600_000

async function render(role: DashboardRole, id: string, eventId: string, tab?: string) {
  session = { user: { id, role } }
  const page = await EventDetailPage({
    params: Promise.resolve({ id: eventId }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  })
  return renderToStaticMarkup(page)
}

/** The page's text, one string per element, so "3" means a figure and not part of "13". */
const figures = (html: string) =>
  html
    .split(/<[^>]+>/)
    .map((t) => t.trim())
    .filter(Boolean)

afterAll(async () => {
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("a venue owner's view of a three-person night", () => {
  let host: string
  let venueOwner: string
  let eventId: string

  beforeAll(async () => {
    host = await makeUser("host", "organizer")
    venueOwner = await makeUser("venue", "organizer")
    await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
    users.push(host, venueOwner)
    const [orgA, orgV] = await Promise.all(
      ["a", "v"].map(async (label) => {
        const org = await db.organisations.create({
          data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" },
        })
        orgs.push(org.id)
        return org.id
      })
    )
    await db.organisation_members.createMany({
      data: [
        { org_id: orgA, user_id: host, role: "owner" },
        { org_id: orgV, user_id: venueOwner, role: "owner" },
      ],
    })
    const venue = await db.venues.create({
      data: { name: testId("v"), city: "Bengaluru", owner_org_id: orgV, claimed_at: new Date(Date.now() - 30 * 24 * HOUR) },
    })
    venues.push(venue.id)

    // Over: started two days ago. Three came; four promised.
    const start = new Date(Date.now() - 48 * HOUR)
    const event = await db.events.create({
      data: {
        slug: testId("three"),
        title: "Three person night",
        description: "integration fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 2 * HOUR),
        timezone: "UTC",
        status: "published",
        organizer_id: host,
        organizer_org_id: orgA,
        venue_id: venue.id,
      },
    })
    eventId = event.id
    events.push(event.id)
    const occ = await db.event_occurrences.create({
      data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: event.end_time },
    })
    const guests = await Promise.all(["g1", "g2", "g3", "g4"].map((l) => makeUser(l)))
    users.push(...guests)
    for (const g of guests) await db.event_rsvps.create({ data: { event_id: event.id, user_id: g, status: "going" } })
    for (const g of guests.slice(0, 3)) {
      await db.event_check_ins.create({
        data: {
          event_id: event.id,
          occurrence_id: occ.id,
          user_id: g,
          kind: "attendee",
          status: "checked_out",
          check_in_time: new Date(start.getTime() + HOUR),
        },
      })
    }
  })

  it("prints the 3 for the organiser, so the venue's absence of it means something", async () => {
    const html = await render("organizer", host, eventId)
    expect(figures(html)).toContain("3")
  })

  it("prints no attendance figure for the venue on the Overview, and says why", async () => {
    const html = await render("venue_owner", venueOwner, eventId)
    const text = figures(html)
    // The page rendered, as the venue's view of this event.
    expect(text).toContain("Your access to this event")
    for (const leak of ["3", "4", "75%"]) expect(text).not.toContain(leak)
    expect(html).toMatch(/fewer than 5/)
    // The day-by-day newcomers and returning are not the venue's.
    expect(html).not.toMatch(/newcomers|returning/i)
  })

  it("prints none on the Attendees tab either", async () => {
    const html = await render("venue_owner", venueOwner, eventId, "attendees")
    const text = figures(html)
    expect(text).toContain("held back")
    expect(text).not.toContain("3")
    expect(html).not.toMatch(/attendee-[0-9a-f]{12}/)
  })
})
