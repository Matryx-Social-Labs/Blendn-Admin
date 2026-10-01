import { test, expect } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { statePathFor } from "./global-setup"

/**
 * The event's Attendees tab, in the browser, on the seeded world (SCRUM-499).
 *
 * It used to redirect to `/messaging?view=attendees` and land on the room
 * chat. Now whoever runs the event gets each person as a label, and the venue
 * the event is held at gets a count and no table.
 *
 * The seeded attendees have real names (`scripts/seed-qa.ts`); none may reach
 * the organiser's page.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })

test.afterAll(async () => {
  await db.$disconnect()
})

const SEEDED_NAMES = ["Ananya Bhat", "Rohan Desai", "Kavya Nair", "Imran Qureshi", "Sneha Pillai", "Vikram Shetty"]

test("the organiser sees labels and no seeded name", async ({ browser }) => {
  const event = await db.events.findFirst({ where: { slug: "founders-filter-coffee", deleted_at: null }, select: { id: true } })
  expect(event, "the seeded event exists").not.toBeNull()

  const context = await browser.newContext({ storageState: statePathFor("organizer") })
  const page = await context.newPage()
  await page.goto(`/dashboard/events/${event!.id}?tab=attendees`, { waitUntil: "domcontentloaded" })

  expect(page.url()).not.toContain("/messaging")
  const table = page.getByRole("table", { name: "Attendees of this event" })
  await expect(table).toBeVisible()
  await expect(table.getByText(/^attendee-[0-9a-f]{12}$/).first()).toBeVisible()
  const text = await page.locator("main").first().innerText()
  for (const name of SEEDED_NAMES) expect(text).not.toContain(name)
  await context.close()
})

test("the venue owner sees a count and no table", async ({ browser }) => {
  // An event at a venue the venue owner's organisation claimed, from the claim on.
  const owner = await db.user.findUniqueOrThrow({ where: { email: "venue.owner@blendn.app" }, select: { id: true } })
  const orgIds = (await db.organisation_members.findMany({ where: { user_id: owner.id }, select: { org_id: true } })).map((m) => m.org_id)
  const venues = await db.venues.findMany({
    where: { owner_org_id: { in: orgIds }, claimed_at: { not: null } },
    select: { id: true, claimed_at: true },
  })
  const candidates = await db.events.findMany({
    where: { deleted_at: null, venue_id: { in: venues.map((v) => v.id) }, organizer_org_id: { notIn: orgIds } },
    select: { id: true, start_time: true, venue_id: true },
  })
  const event = candidates.find((e) => e.start_time >= venues.find((v) => v.id === e.venue_id)!.claimed_at!)
  expect(event, "the seed has another organisation's event at a claimed venue").toBeDefined()

  const context = await browser.newContext({ storageState: statePathFor("venue") })
  const page = await context.newPage()
  await page.goto(`/dashboard/events/${event!.id}?tab=attendees`, { waitUntil: "domcontentloaded" })

  await expect(page.getByText("Came", { exact: true })).toBeVisible()
  await expect(page.getByText("A venue sees how many came, never who", { exact: false })).toBeVisible()
  await expect(page.getByRole("table")).toHaveCount(0)
  expect(await page.locator("main").first().innerText()).not.toMatch(/attendee-[0-9a-f]{12}/)
  await context.close()
})
