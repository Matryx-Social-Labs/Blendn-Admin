import { test, expect, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"

import { statePathFor } from "./global-setup"

/**
 * Rights come from the organisation, not the person's User.role (SCRUM-1246).
 *
 * An `organizer`-role person who is a member of the venue's owning org opens
 * an event held at that venue after its claim: the venue's view is theirs —
 * the room, the held-back count (never who), the venue's door — and nothing
 * of the host's. Until this change the resolver refused anyone whose role was
 * not `venue_owner` and the event 404'd; the door sent them back.
 *
 * Not the seeded organizer@ itself: its organisation runs every seeded event at
 * this venue, so as a venue-org member it would get the host's answer and prove
 * nothing about the venue branch. A fresh organizer-role account isolates it.
 *
 * Then the two-hat case: the same person also joins the running org as staff.
 * Rights are the union: the count stays, edit never comes.
 *
 * The control: organizer@, an owner of the running org (the pilot hosts' shape),
 * keeps the editor on the same event.
 *
 * The account and its memberships are created here and removed by id; the seed is untouched.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const EMAIL = `e2e.venue.member.${Date.now()}@blendn.app`
const COUNT_ONLY = "A venue sees how many came, never who"
let userId: string | null = null

test.afterAll(async () => {
  if (userId) {
    await db.organisation_members.deleteMany({ where: { user_id: userId } })
    await db.user.delete({ where: { id: userId } })
  }
  await db.$disconnect()
})

/** The session NextAuth would set, minted as `global-setup.ts` does (the sign-in form is rate limited and has its own spec). */
async function signedIn(browser: Browser, baseURL: string, id: string) {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error("NEXTAUTH_SECRET is required — it signs the session cookie.")
  const { hostname, protocol } = new URL(baseURL)
  const context = await browser.newContext({ baseURL })
  await context.addCookies([
    {
      name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
      value: await encode({ token: { sub: id, role: "organizer" }, secret, maxAge: 60 * 60 }),
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

/** The venue's view of the event: the room and the count, none of the host's. */
async function expectVenueView(page: Page, eventUrl: string, title: string) {
  await page.goto(eventUrl, { waitUntil: "domcontentloaded" })
  await expect(main(page).getByRole("heading", { level: 1, name: title })).toBeVisible()
  for (const name of ["Room chat", "Attendees"]) await expect(tabs(page).getByRole("link", { name, exact: true })).toBeVisible()
  for (const name of ["Announcements & sponsors", "QR & link"]) {
    await expect(tabs(page).getByRole("link", { name, exact: true })).toHaveCount(0)
  }
  for (const name of ["Edit event", "QR code"]) await expect(main(page).getByRole("link", { name })).toHaveCount(0)
  // The count, never who.
  await page.goto(`${eventUrl}?tab=attendees`, { waitUntil: "domcontentloaded" })
  await expect(main(page).getByText(COUNT_ONLY)).toBeVisible()
  await expect(main(page).getByRole("table")).toHaveCount(0)
  // The editor sends them back.
  await page.goto(`${eventUrl}/edit`, { waitUntil: "domcontentloaded" })
  await expect(page).toHaveURL(new RegExp(`${eventUrl}$`), { timeout: 30_000 })
}

test("an organizer-role member of the venue's org gets the room, the count and the door; the host's owner keeps the editor", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const venue = await db.venues.findFirstOrThrow({
    where: { name: "The Humming Tree", deleted_at: null },
    select: { id: true, owner_org_id: true, claimed_at: true },
  })
  expect(venue.owner_org_id, "the seeded venue is owned").not.toBeNull()
  expect(venue.claimed_at, "and claimed").not.toBeNull()
  const venueOrg = venue.owner_org_id!
  // An event there, from the claim on, that the venue's org does not run.
  const event = await db.events.findFirstOrThrow({
    where: { venue_id: venue.id, kind: "event", deleted_at: null, status: "published", start_time: { gte: venue.claimed_at! }, organizer_org_id: { not: venueOrg } },
    orderBy: { start_time: "asc" },
    select: { id: true, title: true, status: true, organizer_org_id: true },
  })
  const hostOrg = event.organizer_org_id!

  userId = (await db.user.create({ data: { email: EMAIL, name: "Venue Member", role: "organizer" }, select: { id: true } })).id
  await db.organisation_members.create({ data: { org_id: venueOrg, user_id: userId, role: "staff" } })

  // Read back: an organizer-role person, a member of the venue's owning org only.
  expect(await db.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } })).toEqual({ role: "organizer" })
  expect(await db.organisation_members.findMany({ where: { user_id: userId }, select: { org_id: true, role: true } })).toEqual([
    { org_id: venueOrg, role: "staff" },
  ])

  const context = await signedIn(browser, baseURL!, userId)
  const page = await context.newPage()
  const eventUrl = `/dashboard/events/${event.id}`

  await expectVenueView(page, eventUrl, event.title)

  // The room opens, under the same header.
  await page.goto(eventUrl, { waitUntil: "domcontentloaded" })
  await tabs(page).getByRole("link", { name: "Room chat" }).click()
  await expect(page).toHaveURL(new RegExp(`${eventUrl}/messaging$`), { timeout: 30_000 })
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(event.title)

  // The venue's door is theirs.
  await page.goto(`/dashboard/venues/${venue.id}/door`, { waitUntil: "domcontentloaded" })
  await expect(page).toHaveURL(new RegExp(`/dashboard/venues/${venue.id}/door$`))
  await expect(main(page).getByRole("button", { name: "Redeemed" })).toBeVisible()

  // And the events list shows the night, as the resolver grants it.
  await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
  await expect(main(page).getByText(event.title).first()).toBeVisible()

  // Two hats: also staff of the org that runs it. The union: the count stays, edit never comes.
  await db.organisation_members.create({ data: { org_id: hostOrg, user_id: userId, role: "staff" } })
  await expectVenueView(page, eventUrl, event.title)
  await context.close()

  // The control: the running org's owner, same event, keeps the editor and the roster.
  const owner = await db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true, role: true } })
  expect(owner.role).toBe("organizer")
  expect(["owner", "admin"]).toContain(
    (await db.organisation_members.findFirstOrThrow({ where: { org_id: hostOrg, user_id: owner.id }, select: { role: true } })).role
  )
  const ownerContext = await browser.newContext({ storageState: statePathFor("organizer"), baseURL })
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto(eventUrl, { waitUntil: "domcontentloaded" })
  for (const name of ["Edit event", "QR code"]) await expect(main(ownerPage).getByRole("link", { name })).toBeVisible()
  for (const name of ["Attendees", "Announcements & sponsors", "QR & link", "Room chat"]) {
    await expect(tabs(ownerPage).getByRole("link", { name, exact: true })).toBeVisible()
  }
  await ownerPage.goto(`${eventUrl}?tab=attendees`, { waitUntil: "domcontentloaded" })
  await expect(main(ownerPage).getByText(COUNT_ONLY)).toHaveCount(0)
  await ownerContext.close()

  // Read back: both memberships, the venue's owning org and its claim, and the night unchanged.
  expect(
    await db.organisation_members.findMany({ where: { user_id: userId }, select: { org_id: true, role: true }, orderBy: { created_at: "asc" } })
  ).toEqual([
    { org_id: venueOrg, role: "staff" },
    { org_id: hostOrg, role: "staff" },
  ])
  expect(await db.venues.findUniqueOrThrow({ where: { id: venue.id }, select: { owner_org_id: true, claimed_at: true } })).toEqual({
    owner_org_id: venueOrg,
    claimed_at: venue.claimed_at,
  })
  expect(await db.events.findUniqueOrThrow({ where: { id: event.id }, select: { status: true } })).toEqual({ status: event.status })
})
