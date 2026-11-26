import { test, expect } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { statePathFor } from "./global-setup"

/**
 * The seeded organizer's Events list and Reports are their organisations' events, never the
 * events they merely created (SCRUM-942, SCRUM-1250).
 *
 * The drive the task names, as a spec because the host was loaded: the list's tab counts add
 * up to the read-back `SELECT count(*)` over the organisations' rows, and an event the organizer
 * created with no organisation — the legacy row the creator arm existed for — is in neither the
 * list nor the Events CSV. The fixture is made here and removed by id; the seed is untouched.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const LEGACY_TITLE = `Org-less legacy night ${Date.now()}`
let legacyId: string | null = null

test.afterAll(async () => {
  if (legacyId) {
    await db.event_occurrences.deleteMany({ where: { event_id: legacyId } })
    await db.events.delete({ where: { id: legacyId } })
  }
  await db.$disconnect()
})

test.use({ storageState: statePathFor("organizer") })

test("the organizer's Events and Reports are their organisations' events, never one they only created", async ({ page }) => {
  test.setTimeout(90_000)
  const organizer = await db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true } })
  const orgIds = (
    await db.organisation_members.findMany({
      where: { user_id: organizer.id, org: { status: { not: "suspended" } } },
      select: { org_id: true },
    })
  ).map((m) => m.org_id)
  expect(orgIds.length, "the seeded organizer belongs to an organisation").toBeGreaterThan(0)

  // The row the creator arm used to show: created by them, no organisation.
  const start = new Date(Date.now() + 3 * 86_400_000)
  legacyId = (
    await db.events.create({
      data: {
        slug: `e2e-org-less-${Date.now()}`,
        title: LEGACY_TITLE,
        description: "e2e fixture: an event with no organisation",
        start_time: start,
        end_time: new Date(start.getTime() + 3 * 3_600_000),
        timezone: "Asia/Kolkata",
        status: "published",
        organizer_id: organizer.id,
        organizer_org_id: null,
      },
      select: { id: true },
    })
  ).id

  // Read back: what the list should hold, written as SQL rather than through the code under test.
  const [{ count }] = await db.$queryRaw<[{ count: bigint }]>`
    SELECT count(*) FROM events e LEFT JOIN venues v ON v.id = e.venue_id
    WHERE e.deleted_at IS NULL AND e.kind = 'event'
      AND (e.organizer_org_id = ANY(${orgIds}::uuid[])
           OR (v.owner_org_id = ANY(${orgIds}::uuid[]) AND v.claimed_at IS NOT NULL AND e.start_time >= v.claimed_at))`
  const expected = Number(count)
  expect(expected, "the list is uncapped at this size (the page takes 200)").toBeLessThanOrEqual(200)

  // Events: every tab's count, summed, is the read-back; the org-less row is not in any tab.
  await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
  const tabs = page.getByRole("main").getByRole("tablist", { name: "Events by state" }).getByRole("tab")
  await expect(tabs.first()).toBeVisible()
  const labels = await tabs.allInnerTexts()
  const listed = labels.reduce((sum, label) => sum + Number(label.split("·").pop()!.trim()), 0)
  expect(listed, `tab counts ${labels.join(", ")} vs SELECT count(*) = ${expected}`).toBe(expected)
  // The read-back, in the step log: the drive's record.
  console.log(`[read-back] organizer orgs=${orgIds.length} SELECT count(*)=${expected} Events tabs=${labels.join(" | ")}`)
  await expect(page.getByText(LEGACY_TITLE)).toHaveCount(0)

  // Reports: the Events CSV over all time, from the same session.
  const res = await page.request.get("/api/reports/events?range=custom&from=2000-01-01&to=2099-12-31")
  expect(res.status()).toBe(200)
  const csv = await res.text()
  // Control: an event an organisation they own or administer runs is in it, so the absence below is not an empty file.
  const ownRun = await db.events.findFirstOrThrow({
    where: {
      deleted_at: null,
      kind: "event",
      organizer_org: { members: { some: { user_id: organizer.id, role: { in: ["owner", "admin"] } } } },
    },
    select: { id: true },
  })
  expect(csv).toContain(ownRun.id)
  expect(csv).not.toContain(legacyId)
  expect(csv).not.toContain(LEGACY_TITLE)

  // And the fixture is really there: the scope hides it, the database has it.
  const row = await db.events.findUniqueOrThrow({ where: { id: legacyId }, select: { organizer_id: true, organizer_org_id: true, deleted_at: true } })
  expect(row).toEqual({ organizer_id: organizer.id, organizer_org_id: null, deleted_at: null })
})
