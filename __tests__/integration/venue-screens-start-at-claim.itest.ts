let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// The venue's map form imports Leaflet's CSS, which node cannot load. It is
// not what these tests read.
jest.mock("@/app/dashboard/venues/[id]/venue-manage", () => ({ VenueManage: () => null }))

import { isValidElement, type ReactElement, type ReactNode } from "react"
import VenueDetailPage from "@/app/dashboard/venues/[id]/page"
import { VenueEventsTable } from "@/app/dashboard/venues/[id]/venue-events-table"
import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { KpiStrip } from "@/components/dashboard/kit"
import { RatingBars } from "@/components/dashboard/primitives"
import { distinctAttendeeCountsByDay } from "@/lib/attendee-counts"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { confirmVenueLink, disputeVenueLink, getLinkedEventsForOwner } from "@/lib/venue-link-actions"
import { closeDb, db, putInRoom, testId } from "./helpers"
import { DAY, HOUR, VenueClaimWorld, type Night } from "./venue-claim-world"

/*
 * The venue owner's own screens start at the claim too (SCRUM-500): the venue
 * page (its events, ratings and tiles), the building's live count, the linked-
 * events list and the link actions. Each read one venue's events by id and
 * none asked the claim date. And an owned venue cannot be without one.
 */
const w = new VenueClaimWorld()
let n: Record<string, Night>

beforeAll(async () => {
  await w.build()
  const ago = (ms: number) => new Date(Date.now() - ms)
  n = {
    before: await w.night({ venue: w.v1, start: new Date(w.c1.getTime() - 2 * DAY), guests: [6] }),
    after: await w.night({ venue: w.v1, start: ago(DAY), guests: [6] }),
    small: await w.night({ venue: w.v1, start: ago(12 * HOUR), guests: [2] }),
    // Opened an hour before the claim and still running: not the owner's room.
    liveBefore: await w.night({ venue: w.v1, start: new Date(w.c1.getTime() - HOUR), hours: 4 * 24 + 5 }),
    liveAfter: await w.night({ venue: w.v1, start: ago(HOUR), hours: 3 }),
  }
  for (const night of [n.liveBefore, n.liveAfter]) {
    for (let i = 0; i < 2; i++) {
      await putInRoom({ eventId: night.id, occurrenceId: night.days[0], userId: await w.user("vss-in") })
    }
  }
  // Six raters on the night before the claim, enough to show if it leaked.
  for (let i = 0; i < 6; i++) {
    await db.event_ratings.create({ data: { event_id: n.before.id, user_id: await w.user("vss-rater"), rating: 1 } })
  }
})

afterAll(async () => {
  await w.teardown()
  await closeDb()
})

const as = (id: string, role: string) => {
  session = { user: { id, role } }
}

/** Every element of one component in a rendered server component tree. */
function find<P>(node: ReactNode, type: unknown): P[] {
  if (Array.isArray(node)) return node.flatMap((c) => find<P>(c, type))
  if (!isValidElement(node)) return []
  const el = node as ReactElement<{ children?: ReactNode }>
  return [...(el.type === type ? [el.props as P] : []), ...find<P>(el.props.children, type)]
}

async function venuePage(range: { range: string; from?: string; to?: string } = { range: "90d" }, venue = w.v1) {
  return VenueDetailPage({ params: Promise.resolve({ id: venue }), searchParams: Promise.resolve(range) })
}

describe("the venue page shows the venue from its claim on", () => {
  type Row = { id: string; going: number | null; attended: number | null; fillPct: number | null }

  it("lists no night from before the claim, and the admin sees all of them", async () => {
    as(w.owner, "venue_owner")
    const [owner] = find<{ rows: Row[] }>(await venuePage(), VenueEventsTable)
    const ids = owner.rows.map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([n.after.id, n.small.id, n.liveAfter.id]))
    expect(ids).not.toContain(n.before.id)
    expect(ids).not.toContain(n.liveBefore.id)

    as(await w.user("vss-admin", "organizer"), "app_admin")
    const [admin] = find<{ rows: Row[] }>(await venuePage(), VenueEventsTable)
    expect(admin.rows.map((r) => r.id)).toEqual(expect.arrayContaining([n.before.id, n.liveBefore.id]))
  })

  it("cuts a custom range at the claim: the later of the two starts", async () => {
    as(w.owner, "venue_owner")
    const from = new Date(w.c1.getTime() - 10 * DAY).toISOString().slice(0, 10)
    const to = new Date().toISOString().slice(0, 10)
    const [table] = find<{ rows: Row[] }>(await venuePage({ range: "custom", from, to }), VenueEventsTable)
    expect(table.rows.map((r) => r.id)).not.toContain(n.before.id)
    expect(table.rows.map((r) => r.id)).toContain(n.after.id)
  })

  it("holds back another host's small night, and the tiles add up only what is shown", async () => {
    as(w.owner, "venue_owner")
    const tree = await venuePage()
    const [table] = find<{ rows: Row[] }>(tree, VenueEventsTable)
    const small = table.rows.find((r) => r.id === n.small.id)
    expect(small).toMatchObject({ going: 10, attended: null })
    expect(table.rows.find((r) => r.id === n.after.id)).toMatchObject({ attended: 6 })

    // The tiles are the KpiStrip's items (step 17: the kit's strip).
    const attendedTile = find<{ items: { label: string; value: string; hint: string }[] }>(tree, KpiStrip)
      .flatMap((p) => p.items)
      .find((t) => t.label === "Attended")
    const shownTotal = table.rows.reduce((sum, r) => sum + (r.attended !== null && r.going !== null ? r.attended : 0), 0)
    expect(attendedTile?.value).toBe(String(shownTotal))
    expect(attendedTile?.hint).toMatch(/held-back nights left out/)
  })

  it("pools no rating from before the claim", async () => {
    as(w.owner, "venue_owner")
    const tree = await venuePage()
    // Six one-star ratings on the night before: they would render as bars.
    expect(find(tree, RatingBars)).toEqual([])
    const text = JSON.stringify(tree, (_k, v) => (typeof v === "function" ? undefined : v))
    expect(text).toContain("Nobody has rated an event here yet.")

    as(await w.user("vss-admin2", "organizer"), "app_admin")
    expect(find<{ counts: number[] }>(await venuePage(), RatingBars)[0]?.counts[0]).toBe(6)
  })
})

describe("the venue page's tiles add up only what its rows show", () => {
  type Tile = { label: string; value: string | null; hint: string }
  const tiles = async (venue: string) =>
    find<{ items: Tile[] }>(await venuePage({ range: "90d" }, venue), KpiStrip).flatMap((p) => p.items)
  const tile = (all: Tile[], label: string) => all.find((t) => t.label === label)
  const daysAgo = (d: number) => new Date(Date.now() - d * DAY)

  // Each case on its own venue, claimed a month ago, so none depends on another.
  let quiet = ""
  let flips = ""
  let empty = ""
  beforeAll(async () => {
    quiet = await w.venue("vss-quiet", w.venueOrg, daysAgo(30))
    flips = await w.venue("vss-flips", w.venueOrg, daysAgo(30))
    empty = await w.venue("vss-empty", w.venueOrg, daysAgo(30))
    await w.night({ venue: quiet, start: daysAgo(2), guests: [2] })
    await w.night({ venue: quiet, start: daysAgo(3), guests: [3] })
    await w.night({ venue: flips, start: daysAgo(2), guests: [2] })
    await w.night({ venue: flips, start: daysAgo(3), guests: [5] })
  })

  it("reads — when every night is held back, and says why", async () => {
    as(w.owner, "venue_owner")
    const all = await tiles(quiet)
    // "0 attended" would say nobody came; these nights had people in them.
    expect(tile(all, "Attended")).toMatchObject({ value: "—", hint: "GPS check-ins · held-back nights left out" })
    expect(tile(all, "Turn-up")).toMatchObject({ value: null, hint: "held back" })
  })

  it("gives the admin the real totals for the same nights", async () => {
    as(await w.user("vss-admin3", "organizer"), "app_admin")
    const all = await tiles(quiet)
    expect(tile(all, "Attended")).toMatchObject({ value: "5", hint: "GPS check-ins" })
    // 5 of 20 going.
    expect(tile(all, "Turn-up")).toMatchObject({ value: "25%", hint: "of committed RSVPs" })
  })

  it("prints a total once one night reaches the floor, and only that night's", async () => {
    as(w.owner, "venue_owner")
    const all = await tiles(flips)
    expect(tile(all, "Attended")).toMatchObject({ value: "5", hint: "GPS check-ins · held-back nights left out" })
    // 5 of that night's 10 going; the held-back night is out of both sides.
    expect(tile(all, "Turn-up")).toMatchObject({ value: "50%", hint: "of committed RSVPs" })
  })

  it("reads 0 for a venue with no nights in the window: there is nothing to hold back", async () => {
    as(w.owner, "venue_owner")
    const all = await tiles(empty)
    expect(tile(all, "Attended")).toMatchObject({ value: "0", hint: "GPS check-ins" })
    expect(tile(all, "Turn-up")).toMatchObject({ value: null, hint: "needs a past event" })
  })
})

describe("the building's live count is the owner's rooms only", () => {
  it("leaves out a night that opened before the claim, while it runs", async () => {
    const owner = await getBuildingOccupancy(w.v1, { asOwner: { id: w.owner, orgIds: [w.venueOrg] } })
    expect(owner.rooms.map((r) => r.eventId)).toEqual([n.liveAfter.id])
    // The host org's room, so the owner reads its two as a range (SCRUM-516).
    expect(owner.inside).toBe("quiet")

    const admin = await getBuildingOccupancy(w.v1)
    expect(admin.rooms.map((r) => r.eventId).sort()).toEqual([n.liveAfter.id, n.liveBefore.id].sort())
    expect(admin.inside).toBe(4)
  })

  it("is what the page renders for the owner", async () => {
    as(w.owner, "venue_owner")
    const [panel] = find<{ occupancy: { rooms: Array<{ eventId: string }> } }>(await venuePage(), BuildingOccupancyPanel)
    expect(panel.occupancy.rooms.map((r) => r.eventId)).toEqual([n.liveAfter.id])
  })
})

describe("the linked-events list and the link actions start at the claim", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("lists nothing from before the claim", async () => {
    const { rows, total } = await getLinkedEventsForOwner()
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(n.after.id)
    expect(ids).not.toContain(n.before.id)
    expect(ids).not.toContain(n.liveBefore.id)
    expect(total).toBe(rows.length)
  })

  it("refuses to dispute or confirm a night before the claim, and writes nothing", async () => {
    await expect(disputeVenueLink(n.before.id, "Not held at our venue at all.")).rejects.toThrow(/forbidden/i)
    await expect(confirmVenueLink(n.before.id)).rejects.toThrow(/forbidden/i)
    const row = await db.events.findUniqueOrThrow({ where: { id: n.before.id }, select: { venue_link_status: true } })
    expect(row.venue_link_status).not.toBe("disputed")
    expect(row.venue_link_status).not.toBe("confirmed")
  })

  it("confirms a night after it", async () => {
    await confirmVenueLink(n.after.id)
    const row = await db.events.findUniqueOrThrow({ where: { id: n.after.id }, select: { venue_link_status: true } })
    expect(row.venue_link_status).toBe("confirmed")
  })
})

describe("an owned venue always has a claim date", () => {
  it("is refused by the database without one (venues_owner_needs_claimed_at)", async () => {
    await expect(
      db.venues.create({
        data: { name: testId("vss-no-claim"), latitude: 12.9, longitude: 77.5, owner_org_id: w.venueOrg, claimed_at: null },
      })
    ).rejects.toThrow(/venues_owner_needs_claimed_at/)
  })
})

describe("distinctAttendeeCountsByDay", () => {
  it("counts attendee check-ins that happened, per day; staff and the never-arrived are not guests", async () => {
    const staffMix = await w.night({ venue: w.v2, start: new Date(Date.now() - 3 * DAY), guests: [5], staff: [3] })
    const statuses = await w.night({
      venue: w.v2,
      start: new Date(Date.now() - 3 * DAY - HOUR),
      guests: [4],
      statuses: ["checked_out", "pending", "cancelled"],
    })
    const days = await w.night({ venue: w.v2, start: new Date(Date.now() - 6 * DAY), guests: [3, 0], staff: [0, 2] })

    const counts = await distinctAttendeeCountsByDay([...staffMix.days, ...statuses.days, ...days.days])
    expect(counts.get(staffMix.days[0])).toBe(5)
    expect(counts.get(statuses.days[0])).toBe(5)
    expect(counts.get(days.days[0])).toBe(3)
    // A staff-only day has no guests: absent, read as 0 by every caller.
    expect(counts.has(days.days[1])).toBe(false)
  })

  it("asks nothing for no days", async () => {
    expect(await distinctAttendeeCountsByDay([])).toEqual(new Map())
  })
})
