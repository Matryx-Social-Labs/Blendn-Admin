import { test, expect, request as playwrightRequest } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

/**
 * MN-E02 / MN-I12 / G14 over HTTP: what the production build sends for the
 * Analytics page, in every access state, searched as text.
 *
 * Fixtures are their own organisations, so the shared seed world is not
 * changed:
 *
 *   - Org A, past its free window: a first event of six that ended 60 days ago
 *     (open for good, stay 1h 35m); a canary event ten days ago whose every
 *     figure is a needle — 12 people, median stay 2h 53m, the middle half
 *     2h 53m – 3h 50m, 58% left early, 42% of stays ended by the sweeper, every
 *     arrival in the 10-minute slot that starts at 4:20 am IST, and 13 people
 *     who looked in the app; and a pass event twenty days ago (stay 2h 11m)
 *     with an Event Pass.
 *   - Org B, inside its free window: one event of five, five days ago (stay
 *     1h 47m).
 *
 * Each page is fetched twice with a minted session: as HTML (with the RSC
 * payload inlined) and as the flight a client navigation asks for (`RSC: 1`).
 * Absence means nothing without presence, so every needle that is asserted
 * absent somewhere is asserted present once its organisation may see it.
 *
 * No test here depends on another having run: the grant is written and ended
 * inside the one test that needs it.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const tag = `e2e-analytics-${randomUUID().slice(0, 8)}`
const IST_TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })

const users: string[] = []
const orgs: string[] = []
const events: string[] = []
const ids = { owner: "", staff: "", venueOwner: "", admin: "", ownerB: "", orgA: "", orgB: "", first: "", canary: "", pass: "", fresh: "" }
/** Filled in beforeAll: the canary's arrival slot, as the page formats it. */
let arrivalNeedle = ""

/** The canary's figures as the page renders them. Each is checked against the sample in beforeAll. */
const CANARY = {
  stay: "2h 53m",
  quartiles: "middle half 2h 53m – 3h 50m",
  leftEarly: "58%",
  soft: "42% of stays ended",
  viewers: "of 13 who looked",
} as const
/** The same figures as raw numbers in a flight payload: a client component handed the data would carry these. */
const RAW = [/"p50Min":173\b/, /"p75Min":230\b/, /"leftEarlyPct":58\b/, /"softPct":42\b/, /"viewers":13\b/]

async function person(label: string, role: "attendee" | "organizer" | "venue_owner" | "app_admin" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

async function people(label: string, n: number) {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(await person(`${label}${i}`))
  return out
}

async function event(
  org: string,
  organizer: string,
  label: string,
  start: Date,
  stays: { user_id: string; minutes: number; sweeper?: boolean }[]
) {
  const end = new Date(start.getTime() + 4 * 60 * MIN)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${label}`,
      title: `${tag} ${label}`,
      description: "e2e fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: organizer,
      organizer_org_id: org,
    },
  })
  events.push(e.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  for (const s of stays) {
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id: s.user_id, status: "checked_in", check_in_time: start },
    })
    await db.presence_sessions.create({
      data: {
        event_id: e.id,
        occurrence_id: occ.id,
        user_id: s.user_id,
        arrived_at: start,
        departed_at: new Date(start.getTime() + s.minutes * MIN),
        departed_source: s.sweeper ? "sweeper" : "user",
      },
    })
  }
  return e.id
}

async function org(label: string, owner: string, staff?: string) {
  const id = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} ${label}`, status: "verified" } })).id
  orgs.push(id)
  await db.organisation_members.create({ data: { org_id: id, user_id: owner, role: "owner" } })
  if (staff) await db.organisation_members.create({ data: { org_id: id, user_id: staff, role: "staff" } })
  return id
}

test.beforeAll(async () => {
  const now = Date.now()
  ids.owner = await person("owner", "organizer")
  ids.staff = await person("staff", "organizer")
  ids.venueOwner = await person("venue-owner", "venue_owner")
  ids.admin = await person("admin", "app_admin")
  ids.ownerB = await person("owner-b", "organizer")
  ids.orgA = await org("org A", ids.owner, ids.staff)
  ids.orgB = await org("org B", ids.ownerB)

  const firstPeople = await people("first", 6)
  ids.first = await event(ids.orgA, ids.owner, "first", new Date(now - 60 * DAY), firstPeople.map((user_id) => ({ user_id, minutes: 95 })))

  // 04:20 IST, ten days ago: a slot the sample's evening arrivals never use.
  const tenDaysAgo = new Date(now - 10 * DAY)
  const canaryStart = new Date(Date.UTC(tenDaysAgo.getUTCFullYear(), tenDaysAgo.getUTCMonth(), tenDaysAgo.getUTCDate(), 22, 50))
  arrivalNeedle = IST_TIME.format(canaryStart)
  // 7 stay 2h 53m and leave over an hour early; 5 stay 3h 50m (10 minutes
  // before the end). Median 173, p75 230, 7 of 12 left early, 5 of 12 swept.
  const canaryPeople = await people("canary", 12)
  ids.canary = await event(
    ids.orgA,
    ids.owner,
    "canary",
    canaryStart,
    canaryPeople.map((user_id, i) => ({ user_id, minutes: i < 7 ? 173 : 230, sweeper: i < 5 }))
  )
  for (const user_id of await people("viewer", 13)) {
    await db.product_events.create({
      data: { name: "event_viewed", user_id, entity_kind: "event", entity_id: ids.canary, dedupe_key: `${tag}:${randomUUID()}`, occurred_at: new Date(now - 12 * DAY) },
    })
  }

  ids.pass = await event(ids.orgA, ids.owner, "pass", new Date(now - 20 * DAY), canaryPeople.slice(0, 7).map((user_id) => ({ user_id, minutes: 131 })))
  await db.entitlements.create({
    data: {
      subject_kind: "org",
      subject_id: ids.orgA,
      product: "event_pass",
      event_id: ids.pass,
      source: "razorpay",
      external_ref: `order_${tag}`,
      starts_at: new Date(now - 19 * DAY),
    },
  })

  const freshPeople = await people("fresh", 5)
  ids.fresh = await event(ids.orgB, ids.ownerB, "fresh", new Date(now - 5 * DAY), freshPeople.map((user_id) => ({ user_id, minutes: 107 })))
})

test.afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.product_events.deleteMany({ where: { entity_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

type Role = "organizer" | "venue_owner" | "app_admin"

/** A minted session cookie, as global-setup mints them. */
async function session(baseURL: string, userId: string, role: Role) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub: userId, role }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
  return {
    cookies: [
      {
        name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
        value: token,
        domain: hostname,
        path: "/",
        httpOnly: true,
        secure: protocol === "https:",
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    origins: [],
  }
}

/** The page as HTML and as the flight a client navigation fetches, joined. */
async function fetchPage(baseURL: string, userId: string, role: Role, path: string) {
  const ctx = await playwrightRequest.newContext({ baseURL, storageState: await session(baseURL, userId, role) })
  const html = await ctx.get(path)
  const flight = await ctx.get(path, { headers: { RSC: "1" } })
  const out = { status: html.status(), url: html.url(), body: (await html.text()) + "\n" + (await flight.text()) }
  await ctx.dispose()
  return out
}

const analytics = (event: string) => `/dashboard/analytics?event=${event}`

function expectNoCanary(body: string) {
  for (const needle of [...Object.values(CANARY), arrivalNeedle]) expect(body, needle).not.toContain(needle)
  for (const raw of RAW) expect(body, String(raw)).not.toMatch(raw)
}

function expectCanary(body: string) {
  for (const needle of [...Object.values(CANARY), arrivalNeedle]) expect(body, needle).toContain(needle)
}

test("a free organisation's locked event carries the sample and none of its figures, in HTML or flight", async ({ baseURL }) => {
  const page = await fetchPage(baseURL!, ids.owner, "organizer", analytics(ids.canary))
  expect(page.status).toBe(200)
  expect(new URL(page.url).pathname).toBe("/dashboard/analytics")
  expect(page.body).toContain("Free plan")
  expect(page.body).toContain("Sample: Rooftop social")
  expectNoCanary(page.body)
  expect(page.body).not.toContain("2h 11m")
})

test("its first event that cleared the floor stays open", async ({ baseURL }) => {
  const page = await fetchPage(baseURL!, ids.owner, "organizer", analytics(ids.first))
  expect(page.body).toContain("free for good")
  expect(page.body).toContain("1h 35m")
  expectNoCanary(page.body)
})

test("an Event Pass opens its event and nothing else", async ({ baseURL }) => {
  const page = await fetchPage(baseURL!, ids.owner, "organizer", analytics(ids.pass))
  expect(page.body).toContain("2h 11m")
  expect(page.body).toContain("Sample: Rooftop social")
  expectNoCanary(page.body)
})

test("inside the free window, everything is open", async ({ baseURL }) => {
  const page = await fetchPage(baseURL!, ids.ownerB, "organizer", analytics(ids.fresh))
  expect(page.body).toContain("Free until")
  expect(page.body).toContain("1h 47m")
  expect(page.body).not.toContain("Sample: Rooftop social")
})

test("granted Analytics, the owner and a staff member both see every figure (the positive control)", async ({ baseURL }) => {
  const now = new Date()
  const grant = await db.entitlements.create({
    data: {
      subject_kind: "org",
      subject_id: ids.orgA,
      product: "analytics",
      source: "grant",
      starts_at: new Date(now.getTime() - MIN),
      expires_at: new Date(now.getTime() + DAY),
    },
  })
  try {
    for (const id of [ids.owner, ids.staff]) {
      const page = await fetchPage(baseURL!, id, "organizer", analytics(ids.canary))
      expect(page.status).toBe(200)
      expect(page.body).toContain("Founding grant")
      expectCanary(page.body)
    }
  } finally {
    await db.entitlements.delete({ where: { id: grant.id } })
  }
})

for (const [who, role] of [
  ["venueOwner", "venue_owner"],
  ["admin", "app_admin"],
] as const) {
  // A venue owner has a Plan page of their own since step 17 (each venue
  // Listed or on Venue Pro): checked below, and still sent away from Analytics.
  for (const path of role === "venue_owner" ? ["/dashboard/analytics"] : ["/dashboard/plan", "/dashboard/analytics"]) {
    // In a browser: these pages stream, so the redirect arrives in a 200
    // body, which only a browser follows.
    test(`${role} is sent away from ${path}`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, storageState: await session(baseURL!, ids[who], role) })
      try {
        const page = await context.newPage()
        await page.goto(path)
        await expect(page).not.toHaveURL((url) => url.pathname === path)
        expectNoCanary(await page.content())
      } finally {
        await context.close()
      }
    })
  }
}

test("a venue owner's Plan is the venue's, with none of an organiser's figures (step 17)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: await session(baseURL!, ids.venueOwner, "venue_owner") })
  try {
    const page = await context.newPage()
    await page.goto("/dashboard/plan")
    await expect(page).toHaveURL((url) => url.pathname === "/dashboard/plan")
    await expect(page.getByRole("heading", { name: "Venue Pro" })).toBeVisible()
    expectNoCanary(await page.content())
  } finally {
    await context.close()
  }
})

test("the needles are not in the sample (so absence is about the organisation, not the copy)", () => {
  // Read from the module the page draws, not restated here.
  return import("../lib/sample-analytics").then(({ SAMPLE_EVENT_ANALYTICS, SAMPLE_ORG_ANALYTICS }) => {
    const sample = JSON.stringify([SAMPLE_EVENT_ANALYTICS, SAMPLE_ORG_ANALYTICS])
    for (const raw of RAW) expect(sample).not.toMatch(raw)
  })
})
