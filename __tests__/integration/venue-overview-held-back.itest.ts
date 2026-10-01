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

/**
 * Whether `n` appears anywhere in the page's text as a number of its own --
 * in a tile or inside a sentence ("With 3, a count of connections..."). The
 * dates and times are fixed so that none of them contains it, and a digit
 * inside a word -- the fixtures' random ids, in the venue's name -- is not a
 * number.
 */
const mentions = (html: string, n: number) =>
  new RegExp(`(^|[^\\w.:])${n}(?![\\w:%])`).test(figures(html).join(" | "))

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
  let walkInNight: string

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

    // Over: 25 Sept 2026, 14:00 to 16:00 UTC. Three came; four promised.
    const start = new Date("2026-09-25T14:00:00.000Z")
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

    // 26 Sept, 14:00 to 16:00 UTC. Six going, nine came: four walked in, so
    // the count runs past the going list and is held back -- not because it
    // is small, and the page must not say it is.
    const night = await db.events.create({
      data: {
        slug: testId("walkins"),
        title: "Walk-in night",
        description: "integration fixture",
        start_time: new Date("2026-09-26T14:00:00.000Z"),
        end_time: new Date("2026-09-26T16:00:00.000Z"),
        timezone: "UTC",
        status: "published",
        organizer_id: host,
        organizer_org_id: orgA,
        venue_id: venue.id,
      },
    })
    walkInNight = night.id
    events.push(night.id)
    const nightOcc = await db.event_occurrences.create({
      data: { event_id: night.id, occurs_on: new Date("2026-09-26"), start_time: night.start_time, end_time: night.end_time },
    })
    const crowd = await Promise.all(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"].map((l) => makeUser(l)))
    users.push(...crowd)
    for (const g of crowd.slice(0, 6)) await db.event_rsvps.create({ data: { event_id: night.id, user_id: g, status: "going" } })
    for (const g of [...crowd.slice(0, 5), ...crowd.slice(6, 10)]) {
      await db.event_check_ins.create({
        data: {
          event_id: night.id,
          occurrence_id: nightOcc.id,
          user_id: g,
          kind: "attendee",
          status: "checked_out",
          check_in_time: new Date(night.start_time.getTime() + HOUR),
        },
      })
    }
  })

  it("prints the 3 for the organiser, so the venue's absence of it means something", async () => {
    const html = await render("organizer", host, eventId)
    expect(figures(html)).toContain("3")
    expect(mentions(html, 3)).toBe(true)
  })

  it("prints no attendance figure for the venue on the Overview, and says why", async () => {
    const html = await render("venue_owner", venueOwner, eventId)
    const text = figures(html)
    // The page rendered, as the venue's view of this event.
    expect(text).toContain("Your access to this event")
    for (const leak of ["3", "4", "75%"]) expect(text).not.toContain(leak)
    // Not in a sentence either: the Connections panel said "With 3, ...".
    expect(mentions(html, 3)).toBe(false)
    expect(mentions(html, 4)).toBe(false)
    expect(html).toMatch(/held back/)
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

  it("holds back a count that runs past the going list, without calling it small", async () => {
    const organiser = await render("organizer", host, walkInNight)
    expect(mentions(organiser, 9)).toBe(true)

    const venueHtml = await render("venue_owner", venueOwner, walkInNight)
    expect(mentions(venueHtml, 9)).toBe(false)
    // Going is shown: six is above the floor and names nobody.
    expect(figures(venueHtml)).toContain("6")
    expect(venueHtml).toMatch(/held back/)
    expect(venueHtml).not.toMatch(/fewer than 5/)
  })
})
