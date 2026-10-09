import { test, expect, request as playwrightRequest } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

/**
 * MN-E02 / MN-I12 over HTTP: a free organisation's Analytics page, as the
 * production build serves it, carries none of its paid figures.
 *
 * The fixture is its own organisation (so the shared seed world is not
 * changed): an organiser, a first event of six that ended 60 days ago (the
 * paywall's clock started, and ran out), and a canary event ten days ago at
 * which seven people each stayed exactly 173 minutes. Rendered, that median is
 * "2h 53m". The page is fetched with a minted session (as global-setup does),
 * and its whole response — HTML and the RSC payload inlined in it — is
 * searched:
 *
 *   - free: "2h 53m" is absent and the static sample is present;
 *   - after a grant (written here as an admin's grant would be): present. The
 *     positive control; without it, absence proves nothing.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const tag = `e2e-analytics-${randomUUID().slice(0, 8)}`

const users: string[] = []
const events: string[] = []
let orgId = ""
let ownerId = ""
let canaryId = ""

async function event(label: string, start: Date, people: string[], stayMinutes: number) {
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
      organizer_id: ownerId,
      organizer_org_id: orgId,
    },
  })
  events.push(e.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  for (const user_id of people) {
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id, status: "checked_in", check_in_time: start },
    })
    await db.presence_sessions.create({
      data: {
        event_id: e.id,
        occurrence_id: occ.id,
        user_id,
        arrived_at: start,
        departed_at: new Date(start.getTime() + stayMinutes * MIN),
        departed_source: "user",
      },
    })
  }
  return e.id
}

test.beforeAll(async () => {
  const now = Date.now()
  const owner = await db.user.create({ data: { email: `${tag}@e2e.invalid`, name: "E2E analytics owner", role: "organizer" } })
  ownerId = owner.id
  users.push(owner.id)
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: ownerId, role: "owner" } })
  const people: string[] = []
  for (let i = 0; i < 9; i++) {
    const u = await db.user.create({ data: { email: `${tag}-p${i}@e2e.invalid`, name: `p${i}`, role: "attendee" } })
    people.push(u.id)
  }
  users.push(...people)
  await event("first", new Date(now - 60 * DAY), people.slice(0, 6), 95)
  canaryId = await event("canary", new Date(now - 10 * DAY), people.slice(2, 9), 173)
})

test.afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: orgId } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

async function fetchPage(baseURL: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub: ownerId, role: "organizer" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
  const ctx = await playwrightRequest.newContext({
    baseURL,
    storageState: {
      cookies: [
        {
          name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
          value: token,
          domain: hostname,
          path: "/",
          httpOnly: true,
          secure: protocol === "https:",
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
      origins: [],
    },
  })
  const res = await ctx.get(`/dashboard/analytics?event=${canaryId}`)
  const body = await res.text()
  const url = res.url()
  await ctx.dispose()
  return { status: res.status(), url, body }
}

test("a free organisation's Analytics page carries the sample, never its own figures", async ({ baseURL }) => {
  const free = await fetchPage(baseURL!)
  expect(free.status).toBe(200)
  expect(new URL(free.url).pathname).toBe("/dashboard/analytics")
  expect(free.body).toContain("Sample: Rooftop social")
  expect(free.body).not.toContain("2h 53m")
})

test("the same page, granted Analytics, carries them (the positive control)", async ({ baseURL }) => {
  const now = new Date()
  await db.entitlements.create({
    data: {
      subject_kind: "org",
      subject_id: orgId,
      product: "analytics",
      source: "grant",
      starts_at: new Date(now.getTime() - MIN),
      expires_at: new Date(now.getTime() + DAY),
    },
  })
  const granted = await fetchPage(baseURL!)
  expect(granted.status).toBe(200)
  expect(granted.body).toContain("2h 53m")
})
