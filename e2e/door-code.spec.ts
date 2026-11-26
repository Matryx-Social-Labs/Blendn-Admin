import { test, expect, request as playwrightRequest, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { randomUUID } from "node:crypto"

import { signAccessToken } from "../lib/mobile-auth"
import { ROLE_ACCOUNTS } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The door code, driven (gate 13, SCRUM-1316; design/02a host B).
 *
 * As organizer@: a live event's Door tab at 1280 and 390, the full-screen door
 * view, the code read off the page. A QA attendee checks in through the mobile
 * route with that code from 400 m outside the fence; the row is read back
 * (`method = door_code`, `status = checked_in`). The tab then names the
 * arrival by room pseudonym and the full screen shows a count only. Shots go
 * to test-results/screens/ for the `e2e-screens` artifact.
 */
test.use({ storageState: statePathFor("organizer") })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const LAT = 12.9784
const LNG = 77.6408
const HOUR = 3_600_000
// Full page for the tab; the viewport for the full-screen view, which is fixed to it.
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: `test-results/screens/${name}.png`, fullPage })

let eventId: string | undefined
let guestId: string | undefined

test.afterAll(async () => {
  if (eventId) {
    await db.presence_sessions.deleteMany({ where: { event_id: eventId } })
    await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: eventId } } })
    await db.chat_groups.deleteMany({ where: { event_id: eventId } })
    await db.event_match_preferences.deleteMany({ where: { event_id: eventId } })
    await db.check_in_refusals.deleteMany({ where: { event_id: eventId } })
    await db.event_check_ins.deleteMany({ where: { event_id: eventId } })
    await db.audit_logs.deleteMany({ where: { resource_id: eventId } })
    await db.events.deleteMany({ where: { id: eventId } })
  }
  if (guestId) {
    await db.profiles.deleteMany({ where: { id: guestId } })
    await db.user.deleteMany({ where: { id: guestId } })
  }
  await db.$disconnect()
})

test("the host shows the code full screen; a guest 400 m out checks in with it; the Door names the pseudonym, the full screen a count", async ({ page, baseURL }) => {
  // A live event run by organizer@'s organisation, fenced at one point.
  const host = await db.user.findUniqueOrThrow({ where: { email: ROLE_ACCOUNTS.organizer.email }, select: { id: true } })
  const membership = await db.organisation_members.findFirstOrThrow({ where: { user_id: host.id }, select: { org_id: true } })
  const start = new Date(Date.now() - HOUR)
  const end = new Date(Date.now() + 2 * HOUR)
  const event = await db.events.create({
    data: {
      slug: `e2e-door-code-${randomUUID().slice(0, 8)}`,
      title: "Neon Nights at Toit (e2e door code)",
      description: "Saved by e2e/door-code.spec.ts.",
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
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  eventId = event.id
  await db.event_occurrences.create({ data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })

  // The Door tab never draws the code.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/dashboard/events/${event.id}/door`)
  await expect(page.getByRole("navigation", { name: "Event sections" }).getByRole("link", { name: "Door" })).toHaveAttribute("aria-current", "page")
  const show = page.getByRole("button", { name: "Show the door code" })
  await expect(show).toBeVisible()
  await expect(page.getByText(/^Door code: /)).toHaveCount(0)
  await shot(page, "door-tab-1280-empty")

  // Full screen: a named dialog, the glyphs hidden from screen readers, the code spelled out beside them.
  await show.click()
  const dialog = page.getByRole("dialog", { name: /Door code, Neon Nights at Toit/ })
  await expect(dialog).toBeVisible()
  const spelled = (await dialog.getByText(/^Door code: /).textContent())!
  const code = spelled.replace("Door code: ", "").split(", ").join("")
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  await expect(dialog.getByText(/^Changes in \d+ s$/)).toBeVisible()
  await shot(page, "door-fs-1280", false)

  // A QA attendee, 400 m north of the fence, with the code on the screen.
  const guest = await db.user.create({ data: { id: `e2e_door_${randomUUID()}`, email: `door-${randomUUID().slice(0, 8)}@e2e.invalid`, name: "E2E Door Guest", role: "attendee" } })
  guestId = guest.id
  await db.profiles.create({ data: { id: guest.id, name: "E2E Door Guest", onboarded: true, date_of_birth: new Date(Date.now() - 30 * 365.25 * 86_400_000) } })
  const phone = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${signAccessToken(guest.id, guest.email)}` } })
  const res = await phone.post(`/api/mobile/events/${event.id}/checkin`, {
    data: { latitude: LAT + 400 / 111_320, longitude: LNG, deviceInfo: { gpsAccuracy: 30 }, doorCode: `${code.slice(0, 3).toLowerCase()} ${code.slice(3)}` },
  })
  expect(res.status(), await res.text()).toBe(200)
  await phone.dispose()

  // Read back: SELECT method, status FROM event_check_ins WHERE event_id = … AND user_id = …
  const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: event.id, user_id: guest.id }, select: { method: true, status: true } })
  console.log(`READBACK SELECT method, status FROM event_check_ins WHERE event_id = '${event.id}' AND user_id = '${guest.id}' -> ${JSON.stringify(row)}`)
  expect(row).toEqual({ method: "door_code", status: "checked_in" })

  // The full screen faces the queue: a count, never the pseudonym.
  const pseudonym = (await db.chat_group_members.findFirstOrThrow({ where: { user_id: guest.id, chat_group: { event_id: event.id } }, select: { anonymous_name: true } })).anonymous_name!
  await expect(dialog.getByText("1 just came in")).toBeVisible({ timeout: 40_000 })
  await expect(dialog.getByText(pseudonym)).toHaveCount(0)
  await shot(page, "door-fs-1280-echo", false)

  // Close returns focus to "Show the door code"; the tab names the arrival by pseudonym, never an identity.
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(show).toBeFocused()
  const arrivals = page.getByRole("list").filter({ hasText: pseudonym })
  await expect(arrivals).toBeVisible({ timeout: 40_000 })
  await expect(page.getByText("just now")).toBeVisible()
  const html = await page.content()
  for (const leak of [guest.id, guest.email, "E2E Door Guest"]) expect(html).not.toContain(leak)
  await shot(page, "door-tab-1280")

  // A phone held up at the door.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  // Scoped to the page's main: a streamed render can hold a second, hidden copy for a moment.
  await expect(page.locator("#main").getByText(pseudonym)).toBeVisible()
  await shot(page, "door-tab-390")
  await page.locator("#main").getByRole("button", { name: "Show the door code" }).click()
  const phoneDialog = page.getByRole("dialog", { name: /Door code, Neon Nights at Toit/ })
  await expect(phoneDialog).toBeVisible()
  await expect(phoneDialog.getByText(/^Door code: /)).toHaveCount(1)
  await shot(page, "door-fs-390", false)
})
