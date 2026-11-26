import { test, expect, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"

import { statePathFor } from "./global-setup"

/**
 * An organisation's `staff` member runs the night and never edits it (SCRUM-1244).
 *
 * A door volunteer is invited into the host's organisation as `staff`. On the
 * host's running night they get the overview, Live and the Room chat — the room
 * and the door are `canOperate`'s — and no Edit event, no Attendees, no
 * Announcements, no QR & link and no Create event. The roster and the editor
 * are refused on the server too, not only left off the tab list. The owner of
 * the same organisation, on the same night, keeps all of it: that is the
 * control that keeps the staff assertions from passing on a renamed tab.
 *
 * The ticket door itself is not driven here: it opens only while TICKETING is
 * on and the event sells natively, and ticketing is parked (CI runs without
 * it). `ticket-door.itest.ts` lets a staff member's ticket in and reads back
 * `tickets.redeemed_by`.
 *
 * The staff member is created here and removed by id; the seed is untouched.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const STAFF_EMAIL = `e2e.door.staff.${Date.now()}@blendn.app`
let staffId: string | null = null

test.afterAll(async () => {
  if (staffId) {
    await db.organisation_members.deleteMany({ where: { user_id: staffId } })
    await db.user.delete({ where: { id: staffId } })
  }
  await db.$disconnect()
})

/** The session NextAuth would set, minted as `global-setup.ts` does (the sign-in form is rate limited and has its own spec). */
async function staffContext(browser: Browser, baseURL: string, userId: string) {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error("NEXTAUTH_SECRET is required — it signs the session cookie.")
  const { hostname, protocol } = new URL(baseURL)
  const context = await browser.newContext({ baseURL })
  await context.addCookies([
    {
      name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
      value: await encode({ token: { sub: userId, role: "organizer" }, secret, maxAge: 60 * 60 }),
      domain: hostname,
      path: "/",
      httpOnly: true,
      secure: protocol === "https:",
      sameSite: "Lax",
    },
  ])
  return context
}

const main = (page: Page) => page.getByRole("main")
const tabs = (page: Page) => main(page).getByRole("navigation", { name: "Event sections" })

test("an org's staff member gets the room, not the editor or the roster; the owner keeps both", async ({ browser, baseURL }) => {
  test.setTimeout(90_000)
  // The seeded night that is running now, and the organisation that runs it.
  const event = await db.events.findFirstOrThrow({
    where: { slug: "founders-filter-coffee", deleted_at: null },
    select: { id: true, title: true, status: true, organizer_org_id: true, start_time: true, end_time: true },
  })
  const now = new Date()
  expect(event.start_time <= now && now < event.end_time, "the seeded night is running, so Live is offered").toBe(true)
  expect(event.organizer_org_id, "the seeded night belongs to an organisation").not.toBeNull()
  const orgId = event.organizer_org_id!
  const owner = await db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true } })
  const ownerRole = await db.organisation_members.findFirstOrThrow({ where: { org_id: orgId, user_id: owner.id }, select: { role: true } })
  expect(["owner", "admin"]).toContain(ownerRole.role)

  // Invited as staff: the row an accepted invite writes.
  staffId = (await db.user.create({ data: { email: STAFF_EMAIL, name: "Door Volunteer", role: "organizer" }, select: { id: true } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: staffId, role: "staff" } })

  // Read back: the membership is staff, in the organisation that runs the night.
  expect(await db.organisation_members.findMany({ where: { user_id: staffId }, select: { org_id: true, role: true } })).toEqual([
    { org_id: orgId, role: "staff" },
  ])

  const context = await staffContext(browser, baseURL!, staffId)
  const page = await context.newPage()
  const eventUrl = `/dashboard/events/${event.id}`

  await page.goto(eventUrl, { waitUntil: "domcontentloaded" })
  await expect(main(page).getByRole("heading", { level: 1, name: event.title })).toBeVisible()
  await expect(tabs(page).getByRole("link", { name: "Room chat", exact: true })).toBeVisible()
  await expect(tabs(page).getByRole("link", { name: "Live", exact: true })).toBeVisible()
  // (Tickets is off in CI for everyone, so it proves nothing here.)
  for (const name of ["Attendees", "Announcements & sponsors", "QR & link"]) {
    await expect(tabs(page).getByRole("link", { name, exact: true })).toHaveCount(0)
  }
  for (const name of ["Edit event", "QR code"]) await expect(main(page).getByRole("link", { name })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Create event" })).toHaveCount(0)

  // The room is theirs: it opens, under the same header.
  await tabs(page).getByRole("link", { name: "Room chat" }).click()
  await expect(page).toHaveURL(new RegExp(`${eventUrl}/messaging$`), { timeout: 30_000 })
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(event.title)

  // A URL is not a way round the tab list: the roster, the composer and the editor send them back.
  for (const path of [`${eventUrl}?tab=attendees`, `${eventUrl}?tab=announcements`, `${eventUrl}?tab=share`, `${eventUrl}/edit`]) {
    await page.goto(path, { waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(new RegExp(`${eventUrl}$`), { timeout: 30_000 })
  }
  // Nor is the event form theirs: an event they created would refuse them at its own edit screen.
  await page.goto("/dashboard/events/new", { waitUntil: "domcontentloaded" })
  await expect(page).not.toHaveURL(/\/dashboard\/events\/new$/, { timeout: 30_000 })
  // And the event API answers without the creator, as it does a venue.
  const api = await page.request.get(`/api/events/${event.id}`)
  expect(api.status()).toBe(200)
  expect(await api.json()).not.toHaveProperty("organizer_id")
  await context.close()

  // The control: the organisation's owner, same night, keeps the editor and the roster.
  const ownerContext = await browser.newContext({ storageState: statePathFor("organizer"), baseURL })
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto(eventUrl, { waitUntil: "domcontentloaded" })
  for (const name of ["Edit event", "QR code"]) await expect(main(ownerPage).getByRole("link", { name })).toBeVisible()
  await expect(ownerPage.getByRole("link", { name: "Create event" })).toBeVisible()
  for (const name of ["Attendees", "Announcements & sponsors", "QR & link", "Room chat"]) {
    await expect(tabs(ownerPage).getByRole("link", { name, exact: true })).toBeVisible()
  }
  expect(await (await ownerPage.request.get(`/api/events/${event.id}`)).json()).toHaveProperty("organizer_id")
  await ownerContext.close()

  // Read back: nothing the staff member opened changed the night.
  expect(await db.events.findUniqueOrThrow({ where: { id: event.id }, select: { status: true } })).toEqual({ status: event.status })
})
