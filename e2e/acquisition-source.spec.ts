import { test, expect, chromium, request as playwrightRequest, type APIRequestContext } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

import { signAccessToken } from "../lib/mobile-auth"
import { decode } from "../__tests__/support/qr-decode"

/**
 * SCRUM-1273 (insights/02) driven against the real server and database: an attendee arrives from the door
 * QR. `GET /events/<id>?s=door`, an RSVP with `source: "door"` then a `not_going`, a profile save with `door`
 * then `link`; the three rows are read back. A refused view (a draft) writes no `event_viewed` row. The
 * organizer's QR & link tab: the link field says `?s=link`, the code scans to `?s=door`. Run in CI because the
 * host was over the load limit for a local dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `e2e-acq-${randomUUID().slice(0, 8)}`
const HOUR = 60 * 60 * 1000

const users: string[] = []
const events: string[] = []
let orgId = ""
let owner = ""
let guest = ""
let api: APIRequestContext
let live = ""
let draft = ""

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u
}

async function event(label: string, status: "published" | "draft") {
  const start = new Date(Date.now() - HOUR)
  const end = new Date(Date.now() + 3 * HOUR)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${label}`,
      title: `${tag} ${label}`,
      description: "e2e fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status,
      organizer_id: owner,
      organizer_org_id: orgId,
    },
  })
  events.push(e.id)
  await db.event_occurrences.create({ data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  return e.id
}

test.beforeAll(async ({ baseURL }) => {
  owner = (await person("owner", "organizer")).id
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const g = await person("guest")
  guest = g.id
  await db.profiles.create({ data: { id: guest, name: "Door Guest", onboarded: true, date_of_birth: new Date("1995-05-05") } })
  live = await event("live", "published")
  draft = await event("draft", "draft")
  api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${signAccessToken(guest, g.email!)}` } })
})

test.afterAll(async () => {
  await api?.dispose()
  await db.product_events.deleteMany({ where: { user_id: { in: users } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

test("a door arrival is recorded on the view, the RSVP and the profile, and a refused view is not", async () => {
  // Refused first: anything it buffered is flushed no later than the allowed view below.
  expect((await api.get(`/api/mobile/events/${draft}?s=door`)).status()).toBe(404)
  expect((await api.get(`/api/mobile/events/${live}?s=door`)).status()).toBe(200)

  expect((await api.post(`/api/mobile/events/${live}/rsvp`, { data: { status: "going", source: "door" } })).status()).toBe(200)
  expect((await api.post(`/api/mobile/events/${live}/rsvp`, { data: { status: "not_going" } })).status()).toBe(200)

  expect((await api.put(`/api/mobile/profiles/${guest}`, { data: { source: "door" } })).status()).toBe(200)
  const second = await api.put(`/api/mobile/profiles/${guest}`, { data: { source: "link" } })
  expect(second.status()).toBe(200)
  expect((await second.json()).data.profile).not.toHaveProperty("signup_source")

  // SELECT source, status FROM event_rsvps WHERE event_id = <live> AND user_id = <guest>
  const rsvp = await db.event_rsvps.findUniqueOrThrow({ where: { event_id_user_id: { event_id: live, user_id: guest } }, select: { source: true, status: true } })
  // SELECT signup_source FROM profiles WHERE id = <guest>
  const profile = await db.profiles.findUniqueOrThrow({ where: { id: guest }, select: { signup_source: true } })
  // SELECT entity_id, props FROM product_events WHERE name = 'event_viewed' AND user_id = <guest>, after the 10 s flush
  // The refused view was recorded (if at all) before the live one, so it is flushed no later than the live row appears.
  const viewed = () => db.product_events.findMany({ where: { name: "event_viewed", user_id: guest }, select: { entity_id: true, props: true } })
  await expect.poll(async () => (await viewed()).some((v) => v.entity_id === live), { timeout: 30_000 }).toBe(true)
  const views = await viewed()

  console.log(`READBACK ${JSON.stringify({ live, draft, guest, rsvp, profile, views })}`)
  expect(rsvp).toEqual({ source: "door", status: "not_going" })
  expect(profile).toEqual({ signup_source: "door" })
  expect(views).toEqual([{ entity_id: live, props: { source: "door" } }])
})

test("the QR & link tab: the link to copy says ?s=link, the code scans to ?s=door", async ({ baseURL }) => {
  const { hostname, protocol } = new URL(baseURL!)
  const token = await encode({ token: { sub: owner, role: "organizer" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([
    {
      name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
      value: token,
      domain: hostname,
      path: "/",
      httpOnly: true,
      secure: protocol === "https:",
      sameSite: "Lax",
    },
  ])
  const page = await ctx.newPage()
  await page.goto(`/dashboard/events/${live}?tab=share`)

  const link = page.getByLabel("Event link")
  await expect(link).toHaveValue(new RegExp(`/event/${live}\\?s=link$`))
  // The tab's own code; the door slide's (same value) is portaled after it.
  const qr = page.locator(`svg[role="img"][aria-label="QR code for ${tag} live"]`).first()
  const scanned = decode(await qr.evaluate((el) => el.outerHTML))
  console.log(`READBACK ${JSON.stringify({ linkField: await link.inputValue(), qr: scanned })}`)
  expect(scanned).toMatch(new RegExp(`/event/${live}\\?s=door$`))
  await browser.close()
})
