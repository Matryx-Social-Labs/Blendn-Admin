let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { NextRequest } from "next/server"
import { getDashboardOverview } from "@/app/dashboard/actions"
import EventsPage from "@/app/dashboard/events/page"
import { actorFor } from "@/lib/org-membership"
import { attendeeLabel } from "@/lib/pseudonym"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { canRunReport, labelScoper, reportsFor } from "@/lib/reports"
import { closeDb, db } from "./helpers"
import { DAY, HOUR, VenueClaimWorld, type Night } from "./venue-claim-world"

/** The salt `userId` sees for `eventId`'s labels: its organisation's, if theirs (PR #601). */
async function labelsFor(role: "organizer" | "venue_owner", userId: string, eventId: string) {
  const { organizer_org_id } = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { organizer_org_id: true } })
  return (await labelScoper(role, userId))(organizer_org_id)
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const reportRoute = require("@/app/api/reports/[key]/route") as typeof import("@/app/api/reports/[key]/route")

/*
 * F4 / F5 of the analytics audit (SCRUM-500, SCRUM-501): a claim opens a venue
 * from the claim on, and a venue sees counts, never people.
 *
 * Owner's ruling (2026-09-27, SCRUM-355): an approved claim gives the owner no
 * view of events held at the venue before it. `eventPermissions` honoured that;
 * the list and the CSVs did not, so a new owner downloaded one check-in row per
 * guest, by label and to the second, for nights before they owned the place.
 *
 * Driven through the routes a person calls — the events list, the CSV download,
 * the dashboard's Events screen and overview — against a real Postgres.
 */
const w = new VenueClaimWorld()
let n: Record<string, Night>
const CSV_DAYS = { from: new Date(Date.now() - 30 * DAY), to: new Date(Date.now() + 3 * DAY) }
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const localDay = ymd(new Date(Date.now() - 6 * DAY))

beforeAll(async () => {
  await w.build()
  const at = (venue: string, start: Date, rest: Partial<Parameters<VenueClaimWorld["night"]>[0]> = {}) =>
    w.night({ venue, start, ...rest })
  const ago = (ms: number) => new Date(Date.now() - ms)

  n = {
    before: await at(w.v1, new Date(w.c1.getTime() - 5 * DAY), { guests: [6] }),
    justBefore: await at(w.v1, new Date(w.c1.getTime() - 1)),
    atClaim: await at(w.v1, w.c1),
    // Began the day before the claim, runs three days: out, as in the resolver.
    straddle: await at(w.v1, new Date(w.c1.getTime() - DAY), { guests: [6, 6, 6] }),
    after: await at(w.v1, ago(DAY), { guests: [6] }),
    small: await at(w.v1, ago(12 * HOUR), { guests: [2] }),
    four: await at(w.v1, ago(20 * HOUR), { guests: [4] }),
    five: await at(w.v1, ago(22 * HOUR), { guests: [5] }),
    complete: await at(w.v1, ago(30 * HOUR), { guests: [6], going: 6 }),
    residual: await at(w.v1, ago(32 * HOUR), { guests: [5], going: 6 }),
    // Walk-ins: eight came against two going.
    walkIn: await at(w.v1, ago(33 * HOUR), { guests: [8], going: 2 }),
    staffMix: await at(w.v1, ago(34 * HOUR), { guests: [5], staff: [3] }),
    staffFew: await at(w.v1, ago(36 * HOUR), { guests: [3], staff: [2] }),
    statuses: await at(w.v1, ago(38 * HOUR), {
      guests: [4],
      statuses: ["checked_out", "pending", "pending", "cancelled"],
    }),
    // Three days: 6 guests, then 2, then staff only.
    threeDay: await at(w.v1, ago(90 * HOUR), { guests: [6, 2, 0], staff: [0, 0, 2] }),
    // V2 was claimed earlier: between the two claims is open at V2 only.
    v2Between: await at(w.v2, ago(8 * DAY), { guests: [6] }),
    v2Before: await at(w.v2, new Date(w.c2.getTime() - DAY), { guests: [6] }),
    // 18:00 UTC on the day before its local date — a late-night IST start.
    localDay: await at(w.v2, new Date(new Date(`${localDay}T00:00:00Z`).getTime() - 6 * HOUR), {
      guests: [6],
      firstDay: localDay,
    }),
    // The venue owner's org runs this one itself (SCRUM-320), before its claim.
    ownBefore: await at(w.v1, new Date(w.c1.getTime() - 3 * DAY), {
      guests: [2],
      org: w.venueOrg,
      creator: w.owner,
    }),
    elsewhere: await at(w.otherVenue, ago(DAY), { guests: [6] }),
  }
})

afterAll(async () => {
  await w.teardown()
  await closeDb()
})

const as = (id: string, role: string) => {
  session = { user: { id, role } }
}

async function listed(): Promise<string[]> {
  const res = await eventsRoute.GET(new NextRequest("http://localhost/api/events?limit=100"))
  expect(res.status).toBe(200)
  return ((await res.json()) as Array<{ id: string }>).map((e) => e.id)
}

async function csv(key: string, range = CSV_DAYS): Promise<string> {
  const res = await reportRoute.GET(
    new NextRequest(`http://localhost/api/reports/${key}?range=custom&from=${ymd(range.from)}&to=${ymd(range.to)}`),
    { params: Promise.resolve({ key }) }
  )
  expect(res.status).toBe(200)
  // The download carries a BOM for Excel; the rows are what matter here.
  return (await res.text()).replace(/^﻿/, "")
}

const lines = (out: string) => out.split("\r\n")
const rowsFor = (out: string, id: string) => lines(out).filter((l) => l.includes(id))
const lastCell = (row: string) => row.slice(row.lastIndexOf(",") + 1)

describe("a venue owner's list and exports start at the claim (F4)", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("lists the nights after each venue's claim and none before it", async () => {
    const ids = await listed()
    for (const k of ["atClaim", "after", "small", "threeDay", "v2Between", "localDay"]) expect(ids).toContain(n[k].id)
    for (const k of ["before", "justBefore", "straddle", "v2Before", "elsewhere"]) expect(ids).not.toContain(n[k].id)
  })

  it("draws the line where eventPermissions does, for every night in the world", async () => {
    const ids = await listed()
    const actor = await actorFor({ id: w.owner, role: "venue_owner" })
    for (const [name, night] of Object.entries(n)) {
      const event = await db.events.findUniqueOrThrow({ where: { id: night.id }, select: eventPermissionSelect })
      expect({ name, listed: ids.includes(night.id) }).toEqual({
        name,
        listed: eventPermissions(actor, event).canOperate,
      })
    }
  })

  it("leaves the nights before the claim out of the events export", async () => {
    const out = await csv("events")
    expect(out).toContain(n.after.id)
    for (const k of ["before", "justBefore", "straddle", "v2Before", "elsewhere"]) expect(out).not.toContain(n[k].id)
  })

  it("leaves them out of both check-ins exports", async () => {
    for (const key of ["check-ins", "venue-check-ins"]) {
      const out = await csv(key)
      for (const k of ["before", "justBefore", "straddle", "v2Before"]) expect(out).not.toContain(n[k].id)
    }
  })

  it("gives an organiser-role member of the venue's org no venue arm", async () => {
    as(w.colleague, "organizer")
    const ids = await listed()
    expect(ids).not.toContain(n.after.id)
    // Their org's own event, by the organiser arm, as for any organiser.
    expect(ids).toContain(n.ownBefore.id)
  })
})

describe("the venue owner's own events stay theirs to run (SCRUM-320)", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("lists their own night at their own venue, from before the claim", async () => {
    expect(await listed()).toContain(n.ownBefore.id)
  })

  it("exports its check-ins per guest, by label, as any organiser's", async () => {
    const out = await csv("check-ins")
    expect(lines(out)[0]).toBe("Checked in at,Status,Attendee,Event ID,Event,Event start")
    const labels = await labelsFor("venue_owner", w.owner, n.ownBefore.id)
    for (const g of n.ownBefore.guests[0]) expect(out).toContain(attendeeLabel(g, labels))
    expect(rowsFor(out, n.ownBefore.id)).toHaveLength(2)
    // And only their own: no other host's night is in the per-guest file.
    expect(out).not.toContain(n.after.id)
  })

  it("prints its exact counts in the events export, even under the floor", async () => {
    const [row] = rowsFor(await csv("events"), n.ownBefore.id)
    expect(row.split(",").slice(-3)).toEqual(["10", "2", ""])
  })

  it("keeps it out of the venue export, which is other hosts' nights", async () => {
    expect(await csv("venue-check-ins")).not.toContain(n.ownBefore.id)
  })
})

describe("the venue check-ins export is counts, never people (F5)", () => {
  let out: string
  beforeAll(async () => {
    as(w.owner, "venue_owner")
    out = await csv("venue-check-ins")
  })

  it("has exactly the aggregate header, and no label or user id anywhere", async () => {
    expect(lines(out)[0]).toBe("Event ID,Event,Event start,Day,Guests")
    for (const night of Object.values(n)) {
      const labels = await labelsFor("venue_owner", w.owner, night.id)
      for (const g of night.guests.flat()) {
        expect(out).not.toContain(g)
        expect(out).not.toContain(attendeeLabel(g, labels))
      }
    }
  })

  it("is one row per event per day, every day, blank when held back", async () => {
    const rows = rowsFor(out, n.threeDay.id)
    expect(rows).toHaveLength(3)
    // 6 guests; 2 guests; staff only. A day of none and a day of two read alike.
    expect(rows.map(lastCell).sort()).toEqual(["", "", "6"])
  })

  it.each([
    ["four guests: under the floor", "four", ""],
    ["five guests: at the floor", "five", "5"],
    ["six guests of ten going", "after", "6"],
    /*
     * Not held back for a venue (orchestrator's decision, 2026-10-01): it cannot
     * see who RSVP'd, so "everyone who said yes came" names nobody to it, and
     * the going-population rule hid every walk-in night.
     */
    ["every going RSVP came: shown", "complete", "6"],
    ["all but one came: shown", "residual", "5"],
    ["walk-ins past the RSVPs: shown", "walkIn", "8"],
    ["5 guests and 3 staff count 5", "staffMix", "5"],
    ["3 guests and 2 staff count 3, held back", "staffFew", ""],
    ["checked_out counts; pending and cancelled do not", "statuses", "5"],
  ])("%s", (_label, key, expected) => {
    const rows = rowsFor(out, n[key].id)
    expect(rows).toHaveLength(1)
    expect(lastCell(rows[0])).toBe(expected)
  })

  it("puts a day in the window by its own date, not the server's clock", async () => {
    const day = new Date(`${localDay}T12:00:00Z`)
    const one = await csv("venue-check-ins", { from: day, to: day })
    const rows = rowsFor(one, n.localDay.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(`,${localDay},`)
  })

  it("is open to venue owners alone", () => {
    expect(canRunReport("venue-check-ins", "venue_owner")).toBe(true)
    for (const role of ["organizer", "app_admin", "sponsor"] as const) {
      expect(canRunReport("venue-check-ins", role)).toBe(false)
    }
    expect(canRunReport("attendees", "venue_owner")).toBe(false)
  })

  it("says which events each check-ins download holds", () => {
    const shown = Object.fromEntries(reportsFor("venue_owner").map((r) => [r.key, r.description]))
    expect(shown["check-ins"]).toMatch(/your organisation runs/)
    expect(shown["venue-check-ins"]).toMatch(/other hosts' events at your venues, since your claim/)
    expect(reportsFor("organizer").find((r) => r.key === "check-ins")?.description).toBe(
      "Individual GPS-validated check-ins, one row each."
    )
  })
})

describe("other hosts' counts are held back wherever a venue owner sees them", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("blanks Going, Attended and Fill in the events export by the same rule", async () => {
    const out = await csv("events")
    expect(lines(out)[0]).toBe("Event ID,Title,Status,Starts,Ends,City,Venue,Capacity,Going,Attended,Fill %")
    // Going 10, two came: attended under the floor.
    expect(rowsFor(out, n.small.id)[0].split(",").slice(-2)).toEqual(["", ""])
    expect(rowsFor(out, n.small.id)[0].split(",").slice(-3)[0]).toBe("10")
    expect(rowsFor(out, n.five.id)[0].split(",").slice(-2)[0]).toBe("5")
    // Every going RSVP came, and walk-ins past them: shown, as in the venue file.
    expect(rowsFor(out, n.complete.id)[0].split(",").slice(-2)[0]).toBe("6")
    expect(rowsFor(out, n.walkIn.id)[0].split(",").slice(-2)[0]).toBe("8")
  })

  it("blanks them on the Events screen", async () => {
    const page = (await EventsPage()) as { props: { rows: Array<{ id: string; going: number | null; arrivals: number | null }> } }
    const row = (id: string) => page.props.rows.find((r) => r.id === id)
    // Going too: two going is held back for the venue, ten is shown.
    expect(row(n.walkIn.id)?.going).toBeNull()
    expect(row(n.small.id)?.going).toBe(10)
    expect(row(n.small.id)?.arrivals).toBeNull()
    expect(row(n.five.id)?.arrivals).toBe(5)
    expect(row(n.complete.id)?.arrivals).toBe(6)
    expect(row(n.walkIn.id)?.arrivals).toBe(8)
    // Their own night is exact.
    expect(row(n.ownBefore.id)?.arrivals).toBe(2)
  })

  it("leaves the organiser's own exports exact", async () => {
    as(w.host, "organizer")
    const out = await csv("events")
    expect(rowsFor(out, n.small.id)[0].split(",").slice(-2)[0]).toBe("2")
    const checkIns = await csv("check-ins")
    const labels = await labelsFor("organizer", w.host, n.before.id)
    expect(lines(checkIns)[0]).toBe("Checked in at,Status,Attendee,Event ID,Event,Event start")
    for (const g of n.before.guests[0]) expect(checkIns).toContain(attendeeLabel(g, labels))
    expect(rowsFor(checkIns, n.before.id)).toHaveLength(6)
  })
})

describe("the venue owner's home starts at the claim too", () => {
  it("counts no night from before the claim at a venue", async () => {
    as(w.owner, "venue_owner")
    const overview = await getDashboardOverview()
    if (overview.role !== "venue_owner") throw new Error(`expected the venue overview, got ${overview.role}`)
    const v1 = overview.venues.find((v) => v.id === w.v1)
    expect(v1).toBeDefined()
    const ids = await listed()
    const windowStart = Date.now() - 8 * 7 * DAY
    const expected = await db.events.count({
      where: {
        id: { in: ids },
        venue_id: w.v1,
        start_time: { gte: new Date(windowStart), lt: new Date() },
      },
    })
    expect(v1?.eventsInWindow).toBe(expected)
    // And that is fewer than everything ever held there.
    const everything = await db.events.count({
      where: { venue_id: w.v1, start_time: { gte: new Date(windowStart), lt: new Date() } },
    })
    expect(expected).toBeLessThan(everything)
  })
})
