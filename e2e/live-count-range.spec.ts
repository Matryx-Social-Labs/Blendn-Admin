import { test, expect, request as playwrightRequest, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { randomUUID } from "node:crypto"

import { signAccessToken } from "../lib/mobile-auth"
import { ROLE_ACCOUNTS } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The host's room as a range (SCRUM-1328), driven: three guests check in
 * through the app's API, one of them goes quiet 40 minutes ago (their phone in
 * a pocket), and the organizer's Live tab reads "2–3 here" with the sentence
 * on the low end; the Overview's live banner reads the same. That guest's
 * phone then pings, and the tab reads one number. Real time throughout: the
 * server's clock decides the 30-minute window, so the quiet guest is backdated
 * in the database rather than the browser's `Date` being mocked.
 *
 * Screens go to test-results/screens/ for the `e2e-screens` artifact.
 */

test.use({ storageState: statePathFor("organizer") })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const LAT = 12.9716
const LNG = 77.6412
const HOUR = 3_600_000
const QUIET_FOR = 40 * 60_000
const TITLE = "Rooftop Sundowner (e2e count range)"
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true })

let eventId: string | undefined
const guestIds: string[] = []

test.afterAll(async () => {
  try {
    if (eventId) {
      await db.presence_sessions.deleteMany({ where: { event_id: eventId } })
      await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: eventId } } })
      await db.chat_groups.deleteMany({ where: { event_id: eventId } })
      await db.event_match_preferences.deleteMany({ where: { event_id: eventId } })
      await db.check_in_refusals.deleteMany({ where: { event_id: eventId } })
      await db.event_check_ins.deleteMany({ where: { event_id: eventId } })
      await db.event_issues.deleteMany({ where: { event_id: eventId } })
      await db.audit_logs.deleteMany({ where: { resource_id: eventId } })
      await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
      await db.events.deleteMany({ where: { id: eventId } })
    }
    if (guestIds.length) {
      await db.profiles.deleteMany({ where: { id: { in: guestIds } } })
      await db.user.deleteMany({ where: { id: { in: guestIds } } })
    }
  } finally {
    await db.$disconnect()
  }
})

/** SELECT user_id, last_seen_at FROM event_check_ins WHERE event_id = … AND status = 'checked_in', printed to the CI log. */
async function readBack(label: string) {
  const rows = await db.event_check_ins.findMany({
    where: { event_id: eventId, status: "checked_in" },
    select: { user_id: true, last_seen_at: true },
    orderBy: { user_id: "asc" },
  })
  console.log(
    `READBACK ${label}: SELECT user_id, last_seen_at FROM event_check_ins WHERE event_id = '${eventId}' AND status = 'checked_in' -> ${JSON.stringify(rows)}`
  )
  // What the host's figure is counted from: the open sessions' last sighting.
  const sessions = await db.presence_sessions.findMany({
    where: { event_id: eventId, departed_at: null },
    select: { user_id: true, last_seen_at: true },
    orderBy: { user_id: "asc" },
  })
  console.log(`READBACK ${label}: SELECT user_id, last_seen_at FROM presence_sessions WHERE event_id = '${eventId}' AND departed_at IS NULL -> ${JSON.stringify(sessions)}`)
  return { rows, sessions }
}

// The hero: the nearest section around its eyebrow ("In the room · 22:41 · live").
const hero = (page: Page) => page.getByText(/^In the room · /).locator("xpath=ancestor::section[1]")

test("three in, one quiet for 40 minutes: the host reads 2–3 here; once it pings, one number", async ({ page, baseURL }) => {
  test.setTimeout(180_000)

  // A live event run by organizer@'s organisation, started before the seeded one so the Overview's banner is this event.
  const host = await db.user.findUniqueOrThrow({ where: { email: ROLE_ACCOUNTS.organizer.email }, select: { id: true } })
  const membership = await db.organisation_members.findFirstOrThrow({ where: { user_id: host.id }, select: { org_id: true } })
  const start = new Date(Date.now() - 3 * HOUR)
  const end = new Date(Date.now() + 2 * HOUR)
  const event = await db.events.create({
    data: {
      slug: `e2e-count-range-${randomUUID().slice(0, 8)}`,
      title: TITLE,
      description: "Saved by e2e/live-count-range.spec.ts.",
      start_time: start,
      end_time: end,
      timezone: "Asia/Kolkata",
      status: "published",
      visibility: "public",
      city: "Bengaluru",
      organizer_id: host.id,
      organizer_org_id: membership.org_id,
      latitude: LAT,
      longitude: LNG,
      max_capacity: 80,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  eventId = event.id
  await db.event_occurrences.create({ data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })

  // Three QA attendees check in at the pin, through the app's own route.
  const phones = []
  for (const n of [1, 2, 3]) {
    const guest = await db.user.create({
      data: { id: `e2e_range_${randomUUID()}`, email: `range-${n}-${randomUUID().slice(0, 8)}@e2e.invalid`, name: `E2E Range Guest ${n}`, role: "attendee" },
    })
    guestIds.push(guest.id)
    await db.profiles.create({ data: { id: guest.id, name: `E2E Range Guest ${n}`, onboarded: true, date_of_birth: new Date(Date.now() - 30 * 365.25 * 86_400_000) } })
    const phone = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${signAccessToken(guest.id, guest.email)}` } })
    const res = await phone.post(`/api/mobile/events/${event.id}/checkin`, { data: { latitude: LAT, longitude: LNG, deviceInfo: { gpsAccuracy: 12 } } })
    expect(res.status(), await res.text()).toBe(200)
    phones.push(phone)
  }

  // Guest 3's phone went into a pocket 40 minutes ago: arrived then, not seen since.
  const quiet = guestIds[2]
  const then = new Date(Date.now() - QUIET_FOR)
  await db.event_check_ins.updateMany({ where: { event_id: event.id, user_id: quiet }, data: { check_in_time: then, last_seen_at: then } })
  await db.presence_sessions.updateMany({ where: { event_id: event.id, user_id: quiet, departed_at: null }, data: { arrived_at: then, last_seen_at: then } })
  const before = await readBack("one quiet for 40 min")
  const stale = (t: Date | null) => !t || t.getTime() < Date.now() - 30 * 60_000
  expect(before.rows).toHaveLength(3)
  expect(before.rows.filter((r) => stale(r.last_seen_at))).toHaveLength(1)
  expect(before.sessions.filter((r) => stale(r.last_seen_at))).toHaveLength(1)

  // The Live tab: the range, said in full to a screen reader, and the low end in one sentence.
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/dashboard/events/${event.id}?tab=live`)
    const h = hero(page)
    await expect(h).toContainText("2–3", { timeout: 30_000 })
    await expect(h).toContainText("here")
    await expect(h.getByText("2 to 3 people here", { exact: true })).toBeAttached()
    await expect(h).toContainText("2 were seen in the last 30 minutes; the other one is still checked in, but their phone has gone quiet, as phones in pockets do.")
    await expect(h).not.toContainText("count unreliable")
    await expect(h).not.toContainText("not seen in the last")
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    console.log(`LAYOUT live @${width}: sideways ${sideways}px`)
    expect(sideways).toBe(0)
    await shot(page, `live-range-${width}`)
  }

  // The organizer Overview's live banner: the same range, through the same formatter.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/dashboard")
  const banner = page.getByRole("region", { name: `${TITLE} is live` })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("2–3")
  await expect(banner.getByText("2 to 3 people here", { exact: true })).toBeAttached()
  await shot(page, "live-range-overview-1280")

  // Guest 3's phone comes out and pings from the room: everyone seen, one number.
  const ping = await phones[2].post(`/api/mobile/events/${event.id}/presence`, { data: { latitude: LAT, longitude: LNG, accuracy: 12 } })
  expect(ping.status(), await ping.text()).toBe(200)
  const after = await readBack("after the ping")
  expect(after.rows.some((r) => stale(r.last_seen_at))).toBe(false)
  expect(after.sessions.some((r) => stale(r.last_seen_at))).toBe(false)

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/dashboard/events/${event.id}?tab=live`)
    const h = hero(page)
    await expect(h).toContainText("Everyone here was seen in the last 30 minutes.", { timeout: 30_000 })
    await expect(h.getByText("3 people here", { exact: true })).toBeAttached()
    await expect(h).not.toContainText("–3")
    await shot(page, `live-range-equal-${width}`)
  }

  for (const phone of phones) await phone.dispose()
})
