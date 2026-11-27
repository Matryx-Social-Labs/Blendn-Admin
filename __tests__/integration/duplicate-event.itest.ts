/*
 * SCRUM-1153: `/dashboard/events/new?from=<id>` prefills the New event form
 * from an event its owners may edit, and from nothing else.
 *
 * Who may is `eventPermissions(actorFor(user), source).canEdit` and the
 * source's kind: an ordinary event, not deleted. Everybody else gets the plain
 * New event form, the same props for "not yours" as for "no such event", so a
 * stranger learns nothing about an id (or a redirect, when they may not create
 * events at all). Nothing is written until the host saves: rendering the page
 * leaves every table's count as it was.
 *
 * Media: the copy points at the source's own objects. Deleting the source (a
 * soft delete) or replacing its media (rows only) touches no stored object, so
 * the copy's media survive both, and no storage delete is ever called.
 */
let session: { user: { id: string; role: string } } | null = null
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockRedirect = jest.fn((to: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { to })
})
jest.mock("next/navigation", () => ({ redirect: (to: string) => mockRedirect(to), notFound: jest.fn() }))
// The editor is a client tree (Leaflet, CSS); the page's props are what is tested.
jest.mock("@/components/event-editor", () => ({ EventEditor: () => null }))
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  deleteFile: jest.fn(),
  deletePrefix: jest.fn(),
  withdrawFromPublic: jest.fn(),
}))

import { randomUUID } from "crypto"
import type { ReactElement } from "react"
import { NextRequest } from "next/server"

import { SYSTEM_USER_ID } from "@/lib/event-kind"
import * as tigris from "@/lib/tigris"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const page = require("@/app/dashboard/events/new/page") as typeof import("@/app/dashboard/events/new/page")
const createRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
const { duplicateFor } = require("@/lib/event-duplicate") as typeof import("@/lib/event-duplicate")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const orgs: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_media.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.event_details.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

type Role = "owner" | "admin" | "staff"

async function org(label: string, status: "verified" | "suspended" = "verified") {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status } })
  orgs.push(o.id)
  return o.id
}

async function person(label: string, memberships: [string, Role][], role: "organizer" | "app_admin" = "organizer") {
  const id = await makeUser(testId(label), role)
  users.push(id)
  for (const [orgId, r] of memberships) {
    await db.organisation_members.create({ data: { org_id: orgId, user_id: id, role: r } })
  }
  return { id, role }
}

const WEEK = 7 * 24 * 60 * 60 * 1000
const MEDIA_URL = "https://media.example/events/dup-fixture/gallery.jpg"
const COVER_URL = "https://media.example/events/dup-fixture/cover.jpg"

async function sourceEvent(opts: {
  creator: string
  orgId: string | null
  venueId?: string
  kind?: "event" | "venue_day"
  deleted?: boolean
  curated?: boolean
}) {
  const start = new Date(Date.now() - 2 * WEEK)
  const e = await db.events.create({
    data: {
      slug: testId("dup-src"),
      title: testId("Secret source title"),
      description: "SOURCE-DESCRIPTION-SENTINEL",
      start_time: start,
      end_time: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      timezone: "America/Toronto",
      status: "published",
      kind: opts.kind ?? "event",
      visibility: opts.kind === "venue_day" ? "unlisted" : "public",
      organizer_id: opts.creator,
      organizer_org_id: opts.orgId,
      venue_id: opts.venueId ?? null,
      latitude: 43.6435,
      longitude: -79.4239,
      geofence: { type: "circle", lat: 43.6435, lng: -79.4239, radius: 40, buffer: 20 },
      cover_image_url: COVER_URL,
      deleted_at: opts.deleted ? new Date() : null,
      curated_at: opts.curated ? new Date() : null,
      details: { create: { full_description: "SOURCE-DESCRIPTION-SENTINEL long" } },
      media: { create: [{ type: "image", url: MEDIA_URL, order: 0, width: 1600, height: 1600 }] },
    },
  })
  events.push(e.id)
  return e
}

const as = (u: { id: string; role: string }) => (session = { user: { id: u.id, role: u.role } })

/** The page's element: `<EventEditor …props />`, or the redirect it threw. */
async function open(from: string | undefined): Promise<{ props?: Record<string, unknown>; key?: string | null; redirectedTo?: string }> {
  try {
    const el = (await page.default({ searchParams: Promise.resolve(from === undefined ? {} : { from }) })) as ReactElement<Record<string, unknown>>
    return { props: el.props, key: el.key }
  } catch (error) {
    const to = (error as { to?: string }).to
    if (to) return { redirectedTo: to }
    throw error
  }
}

let hostOrg: string
let otherOrg: string
let venueOrg: string
let owner: { id: string; role: string }
let source: Awaited<ReturnType<typeof sourceEvent>>
let plainProps: Record<string, unknown>

beforeAll(async () => {
  hostOrg = await org("dup-host")
  otherOrg = await org("dup-other")
  venueOrg = await org("dup-venue")
  owner = await person("dup-owner", [[hostOrg, "owner"]])
  const venue = await db.venues.create({
    data: { name: testId("dup-venue"), latitude: 43.6435, longitude: -79.4239, owner_org_id: venueOrg, claimed_at: new Date(Date.now() - 52 * WEEK) },
  })
  venues.push(venue.id)
  source = await sourceEvent({ creator: owner.id, orgId: hostOrg, venueId: venue.id })
  as(owner)
  plainProps = (await open(undefined)).props!
})

beforeEach(() => mockRedirect.mockClear())

function expectPlain(result: { props?: Record<string, unknown>; redirectedTo?: string }, baseline = plainProps) {
  if (result.redirectedTo) {
    expect(result.redirectedTo).not.toContain(source.id)
    return
  }
  // The same props as /dashboard/events/new with no ?from: nothing says the id exists.
  expect(result.props).toEqual(baseline)
  const text = JSON.stringify(result.props)
  expect(text).not.toContain("SOURCE-DESCRIPTION-SENTINEL")
  expect(text).not.toContain(source.title)
  expect(text).not.toContain(MEDIA_URL)
}

describe("who may duplicate", () => {
  it("the organising org's owner gets the prefill, as a draft a week or more on", async () => {
    as(owner)
    const { props } = await open(source.id)

    const initial = props?.initialEvent as Record<string, unknown>
    expect(initial).toMatchObject({ title: source.title, status: "draft", venue_id: source.venue_id, geofence: source.geofence })
    expect("id" in initial).toBe(false)
    expect(new Date(initial.start_time as string).getTime()).toBeGreaterThan(Date.now())
    expect(props?.copyNote).toEqual(expect.objectContaining({ lead: expect.stringContaining("A copy of your") }))
  })

  it("keys the editor by its source, so moving between copies, or to a blank form, remounts it", async () => {
    as(owner)
    expect((await open(source.id)).key).toBe(source.id)
    expect((await open(undefined)).key).toBe("new")
    expect((await open(randomUUID())).key).toBe("new")
  })

  it("an admin of the organising org (not its creator) gets the prefill", async () => {
    as(await person("dup-colleague", [[hostOrg, "admin"]]))
    expect((await open(source.id)).props?.initialEvent).toMatchObject({ title: source.title })
  })

  it("an owner of two orgs gets no prefill of the second org's event: the copy would land in the first", async () => {
    const home = await org("dup-home")
    const multi = await person("dup-multi", [[home, "owner"]])
    await db.organisation_members.create({ data: { org_id: hostOrg, user_id: multi.id, role: "owner" } })
    as(multi)
    expectPlain(await open(source.id))
  })

  it("an app admin gets no prefill of an organisation's event: their copy would belong to no organisation", async () => {
    as(await person("dup-admin-org", [], "app_admin"))
    expectPlain(await open(source.id), (await open(undefined)).props)
  })

  it("the loader itself refuses staff, an organizer in no org, and the event's creator once they have left", async () => {
    // The page redirects these before the loader (`mayCreateEvents`); this asks the loader directly.
    const staff = await person("dup-staff-direct", [[hostOrg, "staff"]])
    const orgless = await person("dup-orgless", [])
    const leaver = await person("dup-leaver", [[otherOrg, "owner"]])
    const left = await sourceEvent({ creator: leaver.id, orgId: hostOrg })
    for (const [who, id] of [[staff, source.id], [orgless, source.id], [leaver, left.id]] as const) {
      expect(await duplicateFor({ id: who.id, role: "organizer" }, id)).toBeNull()
    }
  })

  it("a staff member of the organising org gets no prefill", async () => {
    as(await person("dup-staff", [[hostOrg, "staff"]]))
    expectPlain(await open(source.id))
  })

  it("an owner of another organisation gets the plain form", async () => {
    as(await person("dup-stranger", [[otherOrg, "owner"]]))
    expectPlain(await open(source.id))
  })

  it("the venue's owner (canOperate, not canEdit) gets the plain form", async () => {
    as(await person("dup-venue-owner", [[venueOrg, "owner"]]))
    expectPlain(await open(source.id))
  })

  it("a former owner whose organisation is suspended gets the plain form", async () => {
    const suspended = await org("dup-suspended", "suspended")
    const e = await sourceEvent({ creator: owner.id, orgId: suspended })
    as(await person("dup-suspended-owner", [[suspended, "owner"], [otherOrg, "owner"]]))
    const r = await open(e.id)
    expect(JSON.stringify(r.props ?? {})).not.toContain(e.title)
    expect(r.props).toEqual(plainProps)
  })

  it("a deleted event is never a source, even for its own owner", async () => {
    const e = await sourceEvent({ creator: owner.id, orgId: hostOrg, deleted: true })
    as(owner)
    const r = await open(e.id)
    expect(r.props).toEqual(plainProps)
  })

  it("a venue day is never a source, even for an app admin", async () => {
    const venue = await db.venues.create({ data: { name: testId("dup-vd"), latitude: 43.64, longitude: -79.42 } })
    venues.push(venue.id)
    const day = await sourceEvent({ creator: SYSTEM_USER_ID, orgId: null, venueId: venue.id, kind: "venue_day" })
    as(await person("dup-admin", [], "app_admin"))
    const r = await open(day.id)
    expect(r.props?.initialEvent).toBeUndefined()
    expect(JSON.stringify(r.props)).not.toContain(day.title)
  })

  it("a curated event nobody claimed gets the plain form", async () => {
    const curated = await sourceEvent({ creator: owner.id, orgId: null, curated: true })
    as(owner)
    const r = await open(curated.id)
    expect(r.props).toEqual(plainProps)
  })

  it("a ?from that is not a uuid, and one that is no event, read exactly like another org's event", async () => {
    as(owner)
    expect((await open("not-a-uuid")).props).toEqual(plainProps)
    expect((await open("'; drop table events; --")).props).toEqual(plainProps)
    expect((await open(randomUUID())).props).toEqual(plainProps)
    expect((await open(["a", "b"] as unknown as string)).props).toEqual(plainProps)
  })
})

describe("nothing is written until Save", () => {
  it("opening the prefill writes no row and leaves the source as it was", async () => {
    as(owner)
    const before = await db.events.findUniqueOrThrow({ where: { id: source.id } })
    const counts = async () => [
      await db.events.count(), await db.event_media.count(), await db.event_details.count(), await db.audit_logs.count(),
      await db.event_occurrences.count(), await db.event_categories.count(), await db.event_amenities.count(), await db.chat_groups.count(),
    ]
    const was = await counts()

    await open(source.id)
    await open(source.id)

    expect(await counts()).toEqual(was)
    expect(await db.events.findUniqueOrThrow({ where: { id: source.id } })).toEqual(before)
  })
})

describe("media survive the source", () => {
  it("the copy keeps its media when the source's media are replaced and the source is deleted, and no object is deleted", async () => {
    as(owner)
    const initial = (await open(source.id)).props?.initialEvent as Record<string, unknown>
    const res = await createRoute.POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        body: JSON.stringify({ ...initial, media_items: initial.media_items, status: "draft" }),
      })
    )
    expect([res.status, res.status === 200 ? "" : await res.clone().text()]).toEqual([200, ""])
    const copy = (await res.json()) as { id: string; organizer_org_id: string }
    events.push(copy.id)
    expect(copy.organizer_org_id).toBe(hostOrg)
    expect((await db.events.findUniqueOrThrow({ where: { id: copy.id } })).cover_image_url).toBe(COVER_URL)

    const ctx = { params: Promise.resolve({ id: source.id }) }
    const patched = await eventRoute.PATCH(
      new NextRequest(`http://localhost/api/events/${source.id}`, { method: "PATCH", body: JSON.stringify({ media_items: [] }) }),
      ctx
    )
    expect(patched.status).toBe(200)
    expect((await eventRoute.DELETE(new Request("http://localhost"), ctx)).status).toBe(204)

    const media = await db.event_media.findMany({ where: { event_id: copy.id }, select: { url: true } })
    expect(media).toEqual([{ url: MEDIA_URL }])
    expect(tigris.deleteFile).not.toHaveBeenCalled()
    expect(tigris.deletePrefix).not.toHaveBeenCalled()
    expect(tigris.withdrawFromPublic).not.toHaveBeenCalled()
  })
})
