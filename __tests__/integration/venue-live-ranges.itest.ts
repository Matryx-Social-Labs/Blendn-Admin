import type { DashboardRole } from "@/lib/dashboard-types"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
/*
 * The dashboard cookie is a NextAuth JWT, and its crypto is `jose`, which this
 * runner stubs. So the cookie here is the user's id. Everything after the
 * decode is real: the account and its role read from the database, the
 * organisation memberships, `eventPermissions`, the room, the snapshot.
 */
jest.mock("next-auth/jwt", () => ({ decode: async ({ token }: { token: string }) => ({ sub: token }) }))
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// Needs a mounted app router; it is the organiser's venue link in the header.
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))
// The venue's map form imports Leaflet's CSS, which node cannot load. It is
// not what these tests read.
jest.mock("@/app/dashboard/venues/[id]/venue-manage", () => ({ VenueManage: () => null }))

import { createServer } from "http"
import type { AddressInfo } from "net"
import { NextRequest } from "next/server"
import { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"

import { GET as listEvents } from "@/app/api/events/route"
import ChatroomsPage from "@/app/dashboard/chatrooms/page"
import EventsPage from "@/app/dashboard/events/page"
import { EventsTable } from "@/app/dashboard/events/events-table"
import { EventAttendeesCount } from "@/app/dashboard/events/[id]/attendees-table"
import { Overview } from "@/app/dashboard/events/[id]/overview"
import EventDetailPage from "@/app/dashboard/events/[id]/page"
import VenueDetailPage from "@/app/dashboard/venues/[id]/page"
import { VenueEventsTable } from "@/app/dashboard/venues/[id]/venue-events-table"
import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { LiveTab } from "@/components/dashboard/live-tab"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import type { LiveSnapshot, VenueLiveSnapshot } from "@/lib/live-metrics"
import { buildReport } from "@/lib/reports"
import { initSocketServer, stopAllOpsBroadcasts } from "@/lib/socket-server"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"
import { venueDayFor } from "@/lib/venue-day"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

/**
 * A venue owner's Live tab printed exact counts for another host's night
 * (SCRUM-516): "3 checked in", the arrival rate, the Left tile -- one click
 * from an Overview that held the same 3 back.
 *
 * Now a venue watching a night it does not run, or its own venue day, is sent
 * every count of people as a bucket (a few / 5–9 / 10–19 / 20+, D-19), from the
 * server, so no exact count reaches its browser by the socket or by the page.
 * The organiser and an admin are the controls: they must still get 3 and 12,
 * or "no 3 for the venue" proves nothing.
 *
 * A real socket.io server -- `initSocketServer`, its auth, its join handler and
 * its 5-second tick -- on real rows. The pages are rendered from their server
 * components, and their props are the payload the browser receives.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
const clients: ClientSocket[] = []
const DAY = 24 * 3_600_000

const httpServer = createServer()
let host = ""
let venueOwner = ""
let admin = ""
let stranger = ""
let three = ""
let twelve = ""
let venueDay = ""
let hostOrg = ""

type Snapshot = LiveSnapshot | VenueLiveSnapshot

/** Every key in a payload whose value is a number, wherever it sits. */
function numericKeys(value: unknown, at = ""): string[] {
  if (typeof value === "number") return [at]
  if (Array.isArray(value)) return value.flatMap((v) => numericKeys(v, at))
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numericKeys(v, at ? `${at}.${k}` : k))
  }
  return []
}

/** The only numbers a venue's snapshot may carry: none of them counts people. */
const VENUE_NUMBERS = ["capacity", "messagesPerMinute", "openFlags"]

async function org(label: string, member: string) {
  const o = await db.organisations.create({ data: { display_name: testId(label), kind: "company", status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: member, role: "owner" } })
  return o.id
}

async function fill(eventId: string, people: number) {
  const occurrenceId = await occurrenceOf(eventId)
  for (let i = 0; i < people; i++) {
    const userId = await makeUser("vlr-guest")
    users.push(userId)
    await putInRoom({ eventId, occurrenceId, userId })
  }
}

/**
 * Open a dashboard socket as `userId`, join the event's ops room, and collect
 * what arrives until `until` says enough.
 */
async function watch(
  userId: string,
  eventId: string,
  until: (seen: { snapshots: Snapshot[]; errors: string[] }) => boolean = (s) => s.snapshots.length + s.errors.length > 0
) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, {
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { cookie: `next-auth.session-token=${userId}` },
  })
  clients.push(socket)
  const seen = { snapshots: [] as Snapshot[], errors: [] as string[] }
  socket.on("ops:snapshot", (s: Snapshot) => seen.snapshots.push(s))
  socket.on("error", (e: { code?: string }) => seen.errors.push(e.code ?? "?"))
  socket.on("connect", () => socket.emit("join:eventOps", eventId))
  for (let waited = 0; !until(seen) && waited < 15_000; waited += 50) {
    await new Promise((r) => setTimeout(r, 50))
  }
  socket.close()
  return seen
}

/** Every element of one component in a rendered server component tree. */
function find<P>(node: ReactNode, type: unknown): P[] {
  if (Array.isArray(node)) return node.flatMap((c) => find<P>(c, type))
  if (!isValidElement(node)) return []
  const el = node as ReactElement<{ children?: ReactNode }>
  return [...(el.type === type ? [el.props as P] : []), ...find<P>(el.props.children, type)]
}

function as(id: string, role: DashboardRole) {
  session = { user: { id, role } }
}

const eventPage = (eventId: string, tab?: string) =>
  EventDetailPage({ params: Promise.resolve({ id: eventId }), searchParams: Promise.resolve(tab ? { tab } : {}) })

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET ||= "itest-nextauth-secret-at-least-32-characters"
  delete process.env.REDIS_URL

  host = await makeUser("vlr-host", "organizer")
  venueOwner = await makeUser("vlr-venue", "organizer")
  admin = await makeUser("vlr-admin", "app_admin")
  stranger = await makeUser("vlr-stranger", "organizer")
  users.push(host, venueOwner, admin, stranger)
  await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
  hostOrg = await org("vlr-host-org", host)
  const venueOrg = await org("vlr-venue-org", venueOwner)
  await org("vlr-stranger-org", stranger)

  const venue = await db.venues.create({
    data: {
      name: testId("vlr-venue"),
      city: "Bengaluru",
      latitude: 12.9716,
      longitude: 77.5946,
      capacity: 100,
      owner_org_id: venueOrg,
      claimed_at: new Date(Date.now() - 30 * DAY),
    },
  })
  venues.push(venue.id)

  // Two nights another host runs in the venue's building, live now.
  for (const people of [3, 12]) {
    const eventId = await makeEvent(host)
    events.push(eventId)
    // The three-person night states a capacity of 2, so its over-capacity alert fires.
    await db.events.update({
      where: { id: eventId },
      data: { venue_id: venue.id, organizer_org_id: hostOrg, max_capacity: people === 3 ? 2 : null },
    })
    await fill(eventId, people)
    if (people === 3) three = eventId
    else twelve = eventId
  }
  // What the issue sweeper wrote down earlier tonight, figures and all.
  await db.event_issues.createMany({
    data: [
      {
        event_id: twelve,
        kind: "leaving_early",
        severity: "warning",
        title: "Leaving early",
        body: "4 of 16 have checked out with 97 minutes still to run.",
      },
      {
        event_id: twelve,
        kind: "over_capacity",
        severity: "critical",
        title: "Over stated capacity",
        body: "14 guests against capacity 11 — 3 over. Staff aren't counted toward fill; 14 bodies are in the room.",
      },
    ],
  })

  // And the venue's own day room, with three people live in it.
  const day = await venueDayFor(venue.id)
  if (!day) throw new Error("no venue day")
  venueDay = day.id
  events.push(venueDay)
  await fill(venueDay, 3)

  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  initSocketServer(httpServer)
}, 60_000)

afterAll(async () => {
  for (const c of clients) c.close()
  stopAllOpsBroadcasts()
  stopSponsoredScheduler()
  await new Promise<void>((resolve) => globalThis.__blendnSocketIo?.close(() => resolve()) ?? resolve())
  globalThis.__blendnSocketIo = null
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
}, 60_000)

describe("the ops socket", () => {
  it.each([
    ["three", () => three, "a_few"],
    ["twelve", () => twelve, "10-19"],
  ])("sends the venue owner the %s-person room as ranges, with no count of people as a number", async (_n, id, range) => {
    const { snapshots, errors } = await watch(venueOwner, id())
    expect(errors).toEqual([])
    const [first] = snapshots
    expect(first).toMatchObject({
      view: "venue",
      inside: range,
      guestsInside: range,
      checkedInTotal: range,
      checkedOutTotal: "none",
      checkInRate10m: range,
    })
    expect(numericKeys(first).filter((k) => !VENUE_NUMBERS.includes(k))).toEqual([])
  })

  it("sends the alerts decided on the exact figures, with the figures for the organiser and without them for the venue", async () => {
    const [hostView] = (await watch(host, three)).snapshots
    expect(hostView).toMatchObject({ view: "host", overCapacity: true })
    expect(hostView.alerts.map((a) => a.body)).toEqual([expect.stringMatching(/^3 guests against capacity 2 — 1 over/)])

    const [venueView] = (await watch(venueOwner, three)).snapshots
    expect(venueView).toMatchObject({ view: "venue", overCapacity: true, capacity: 2 })
    expect(venueView.alerts).toEqual([
      { kind: "over_capacity", severity: "critical", title: "Over stated capacity", body: "More guests than the event's stated capacity." },
    ])
  })

  it("keeps ticking for a venue watching alone", async () => {
    const { snapshots } = await watch(venueOwner, three, (s) => s.snapshots.length >= 2)
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    for (const s of snapshots) expect(s).toMatchObject({ view: "venue", inside: "a_few" })
  }, 30_000)

  /** Emit one join as `userId` and collect what comes back within three seconds. */
  async function ask(userId: string, event: "join:event" | "join:eventOps", payload: unknown) {
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { cookie: `next-auth.session-token=${userId}` },
    })
    clients.push(socket)
    const seen = { errors: [] as string[], snapshots: 0 }
    socket.on("error", (e: { code?: string }) => seen.errors.push(e.code ?? "?"))
    socket.on("ops:snapshot", () => (seen.snapshots += 1))
    socket.on("connect", () => socket.emit(event, payload as string))
    for (let waited = 0; seen.errors.length === 0 && waited < 3_000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50))
    }
    socket.close()
    return seen
  }

  it("keeps a dashboard cookie out of the attendee counter room, which carries the exact count", async () => {
    expect(await ask(venueOwner, "join:event", twelve)).toEqual({ errors: ["FORBIDDEN"], snapshots: 0 })
  })

  it("refuses an ops id that is not a uuid, which would name a room and a loop of its own", async () => {
    expect(await ask(host, "join:eventOps", { in: [twelve] })).toEqual({ errors: ["OPS_FORBIDDEN"], snapshots: 0 })
  })

  it.each([
    ["the organiser", () => host],
    ["an admin", () => admin],
  ])("sends %s the exact figures", async (_who, who) => {
    for (const [id, n] of [[three, 3], [twelve, 12]] as const) {
      const [first] = (await watch(who(), id)).snapshots
      expect(first).toMatchObject({ view: "host", inside: n, guestsInside: n, checkedInTotal: n, checkInRate10m: n })
    }
  })

  it("on the venue day, sends its owner ranges and an admin the figures", async () => {
    const [owner] = (await watch(venueOwner, venueDay)).snapshots
    expect(owner).toMatchObject({ view: "venue", inside: "a_few", checkedInTotal: "a_few" })
    expect(numericKeys(owner).filter((k) => !VENUE_NUMBERS.includes(k))).toEqual([])

    const [adminView] = (await watch(admin, venueDay)).snapshots
    expect(adminView).toMatchObject({ view: "host", inside: 3, checkedInTotal: 3 })
  })

  it("keeps the two copies apart on the 5-second tick, with both watching at once", async () => {
    const twice = (s: { snapshots: Snapshot[] }) => s.snapshots.length >= 2
    const [venueSeen, hostSeen] = await Promise.all([watch(venueOwner, twelve, twice), watch(host, twelve, twice)])
    // The second of each came from the tick, not the join.
    expect(venueSeen.snapshots.length).toBeGreaterThanOrEqual(2)
    expect(hostSeen.snapshots.length).toBeGreaterThanOrEqual(2)
    for (const s of venueSeen.snapshots) {
      expect(s).toMatchObject({ view: "venue", inside: "10-19" })
      expect(numericKeys(s).filter((k) => !VENUE_NUMBERS.includes(k))).toEqual([])
    }
    for (const s of hostSeen.snapshots) expect(s).toMatchObject({ view: "host", inside: 12 })
  }, 30_000)

  it("stops sending to a watcher whose access was taken away, once it asks again", async () => {
    const member = await makeUser("vlr-member", "organizer")
    users.push(member)
    await db.organisation_members.create({ data: { org_id: hostOrg, user_id: member, role: "owner" } })
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { cookie: `next-auth.session-token=${member}` },
    })
    clients.push(socket)
    const snapshots: Snapshot[] = []
    const errors: string[] = []
    socket.on("ops:snapshot", (s: Snapshot) => snapshots.push(s))
    socket.on("error", (e: { code?: string }) => errors.push(e.code ?? "?"))
    socket.on("connect", () => socket.emit("join:eventOps", twelve))
    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50))
    }
    await until(() => snapshots.length > 0)
    expect(snapshots[0]).toMatchObject({ view: "host", inside: 12 })

    // Leaves the organisation, with the tab still open, and the page asks again.
    await db.organisation_members.deleteMany({ where: { org_id: hostOrg, user_id: member } })
    socket.emit("join:eventOps", twelve)
    await until(() => errors.length > 0)
    expect(errors).toEqual(["OPS_FORBIDDEN"])
    const before = snapshots.length
    await new Promise((r) => setTimeout(r, 6_000)) // past one tick
    socket.close()
    expect(snapshots.length).toBe(before)
  }, 30_000)

  it("refuses somebody who may not operate the event, as denied rather than as a dropped connection", async () => {
    const { snapshots, errors } = await watch(stranger, twelve)
    expect(snapshots).toEqual([])
    expect(errors).toEqual(["OPS_FORBIDDEN"])
  })
})

describe("the event page's payload", () => {
  type Issues = { issues: Array<{ kind: string; body: string }> }

  it("hands the Live tab the logged issue without its figures for the venue, with them for the organiser", async () => {
    as(venueOwner, "venue_owner")
    const [venueTab] = find<Issues>(await eventPage(twelve, "live"), LiveTab)
    // Leaving early is not sent at all: it flips at an exact share of arrivals.
    expect(venueTab.issues).toEqual([
      expect.objectContaining({ kind: "over_capacity", body: "More guests than the event's stated capacity." }),
    ])
    expect(JSON.stringify(venueTab)).not.toMatch(/\b(3|4|11|14|16|97) /)

    as(host, "organizer")
    const [hostTab] = find<Issues>(await eventPage(twelve, "live"), LiveTab)
    expect(hostTab.issues.map((i) => i.body).sort()).toEqual([
      "14 guests against capacity 11 — 3 over. Staff aren't counted toward fill; 14 bodies are in the room.",
      "4 of 16 have checked out with 97 minutes still to run.",
    ])
  })

  type OverviewProps = { overview: { hero: { label: string; value: string | null }; tiles: Array<{ label: string; value: string | null }> } }
  const live = (p: OverviewProps) => ({
    now: p.overview.hero.value,
    ever: p.overview.tiles.find((t) => t.label === "Ever checked in")?.value,
  })

  it("gives the Overview's live counts as ranges to the venue and exactly to the organiser", async () => {
    as(venueOwner, "venue_owner")
    expect(live(find<OverviewProps>(await eventPage(three), Overview)[0])).toEqual({ now: "a few", ever: "a few" })
    expect(live(find<OverviewProps>(await eventPage(twelve), Overview)[0])).toEqual({ now: "10–19", ever: "10–19" })

    as(host, "organizer")
    expect(live(find<OverviewProps>(await eventPage(three), Overview)[0])).toEqual({ now: "3", ever: "3" })
    expect(live(find<OverviewProps>(await eventPage(twelve), Overview)[0])).toEqual({ now: "12", ever: "12" })
  })

  it("gives the Attendees tab's count as a range while the night runs", async () => {
    as(venueOwner, "venue_owner")
    const [count] = find<{ came: unknown }>(await eventPage(twelve, "attendees"), EventAttendeesCount)
    expect(count.came).toBe("10-19")
    expect(renderToStaticMarkup(EventAttendeesCount({ started: true, came: "10-19" }))).toMatch(/10–19.*a range until it ends/)
  })
})

describe("the venue's lists", () => {
  type Panel = { occupancy: { inside: unknown; fillPct: unknown; rooms: Array<{ eventId: string; inside: unknown }> } }

  it("ranges the rooms another host runs in the building, and prints no total they would add up to", async () => {
    as(venueOwner, "venue_owner")
    const venuePage = await VenueDetailPage({ params: Promise.resolve({ id: venues[0] }), searchParams: Promise.resolve({}) })
    const [panel] = find<Panel>(venuePage, BuildingOccupancyPanel)
    expect(panel.occupancy.rooms).toEqual([
      expect.objectContaining({ eventId: twelve, inside: "10-19", guestsInside: null, staffInside: null }),
      expect.objectContaining({ eventId: three, inside: "a_few", guestsInside: null, staffInside: null }),
    ])
    expect(panel.occupancy.inside).toBeNull()
    expect(numericKeys(panel.occupancy)).toEqual(["capacity"])

    as(admin, "app_admin")
    const [adminPanel] = find<Panel>(
      await VenueDetailPage({ params: Promise.resolve({ id: venues[0] }), searchParams: Promise.resolve({}) }),
      BuildingOccupancyPanel
    )
    expect(adminPanel.occupancy).toMatchObject({ inside: 15, fillPct: 15 })
  })

  it("ranges the same rooms on the Chatrooms list, without a total", async () => {
    as(venueOwner, "venue_owner")
    const venueHtml = renderToStaticMarkup(await ChatroomsPage())
    expect(venueHtml).toMatch(/>10–19<\/b> inside/)
    expect(venueHtml).toMatch(/>a few<\/b> inside/)
    expect(venueHtml).not.toMatch(/people inside|person inside/)

    as(host, "organizer")
    const hostHtml = renderToStaticMarkup(await ChatroomsPage())
    expect(hostHtml).toMatch(/>12<\/b> inside/)
    expect(hostHtml).toMatch(/>15<\/b> people inside/)

    as(admin, "app_admin")
    const adminHtml = renderToStaticMarkup(await ChatroomsPage())
    expect(adminHtml).toMatch(/>12<\/b> inside/)
    expect(adminHtml).toMatch(/>3<\/b> inside/)
  })

  it("ranges the live count in GET /api/events for the venue, not for the organiser", async () => {
    const occupancyOf = async () => {
      const rows = (await (await listEvents(new NextRequest("http://localhost/api/events"))).json()) as Array<{
        id: string
        occupancy: unknown
      }>
      return Object.fromEntries(rows.filter((r) => r.id === three || r.id === twelve).map((r) => [r.id, r.occupancy]))
    }
    as(venueOwner, "venue_owner")
    expect(await occupancyOf()).toEqual({ [three]: "a_few", [twelve]: "10-19" })
    as(host, "organizer")
    expect(await occupancyOf()).toEqual({ [three]: 3, [twelve]: 12 })
    as(admin, "app_admin")
    expect(await occupancyOf()).toEqual({ [three]: 3, [twelve]: 12 })
  })

  it("holds back who came at a night still running, on the Events list, the venue page and both exports", async () => {
    type Row = { id: string; arrivals?: unknown; attended?: unknown }
    const running = (rows: Row[], key: "arrivals" | "attended") =>
      Object.fromEntries(rows.filter((r) => r.id === three || r.id === twelve).map((r) => [r.id, r[key]]))

    as(venueOwner, "venue_owner")
    const [list] = find<{ rows: Row[] }>(await EventsPage(), EventsTable)
    expect(running(list.rows, "arrivals")).toEqual({ [three]: null, [twelve]: null })
    const venuePage = await VenueDetailPage({ params: Promise.resolve({ id: venues[0] }), searchParams: Promise.resolve({}) })
    const [table] = find<{ rows: Row[] }>(venuePage, VenueEventsTable)
    expect(running(table.rows, "attended")).toEqual({ [three]: null, [twelve]: null })

    const range = { key: "custom" as const, from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) }
    const cell = (csv: string, id: string, column: string) => {
      const [header, ...lines] = csv.trim().split(/\r?\n/)
      const at = header.split(",").indexOf(column)
      return lines.find((l) => l.includes(id))?.split(",")[at]
    }
    const events = await buildReport("events", "venue_owner", venueOwner, range)
    expect(cell(events, twelve, "Attended")).toBe("")
    const days = await buildReport("venue-check-ins", "venue_owner", venueOwner, range)
    expect(cell(days, twelve, "Guests")).toBe("")

    // The organiser's own list and export: exact.
    as(host, "organizer")
    const [hostList] = find<{ rows: Row[] }>(await EventsPage(), EventsTable)
    expect(running(hostList.rows, "arrivals")).toEqual({ [three]: 3, [twelve]: 12 })
    expect(cell(await buildReport("events", "organizer", host, range), twelve, "Attended")).toBe("12")
  })

  it("orders ranged rooms by what is shown, and flags a building over its licence without a total", async () => {
    // Two rooms the owner reads as "a few": exact order would put BBB (4) first.
    const small = await db.venues.create({
      data: { name: testId("vlr-small"), city: "Bengaluru", capacity: 3, owner_org_id: (await db.venues.findUniqueOrThrow({ where: { id: venues[0] } })).owner_org_id, claimed_at: new Date(Date.now() - 30 * DAY) },
    })
    venues.push(small.id)
    const rooms: Record<string, string> = {}
    for (const [title, people] of [["AAA room", 1], ["BBB room", 4]] as const) {
      const eventId = await makeEvent(host)
      events.push(eventId)
      await db.events.update({ where: { id: eventId }, data: { title, venue_id: small.id, organizer_org_id: hostOrg } })
      await fill(eventId, people)
      rooms[title] = eventId
    }

    const owner = await getBuildingOccupancy(small.id, { asOwner: { id: venueOwner, orgIds: [small.owner_org_id!] } })
    expect(owner.rooms.map((r) => [r.eventId, r.inside])).toEqual([
      [rooms["AAA room"], "a_few"],
      [rooms["BBB room"], "a_few"],
    ])
    expect(owner).toMatchObject({ inside: null, fillPct: null, overCapacity: true })

    const exact = await getBuildingOccupancy(small.id)
    expect(exact.rooms.map((r) => r.eventId)).toEqual([rooms["BBB room"], rooms["AAA room"]])
    expect(exact).toMatchObject({ inside: 5, fillPct: 167, overCapacity: true })
  })
})
