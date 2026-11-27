import { test, expect, request as playwrightRequest, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { randomUUID } from "node:crypto"

import { signAccessToken } from "../lib/mobile-auth"

/**
 * SCRUM-1176 driven: three people in a live room each report a message through
 * the app's route (spam, harassment, threat), the threatening message's row is
 * then hard-deleted, and the admin opens the reports queue. The card still
 * quotes the threat as it was reported, and the threat sits above the
 * harassment above the spam although it is the newest. With more than a page
 * of reports waiting, the screen says the queue is cut to the most severe, and
 * the footer says the order. The Pending tab is saved at 1280 and 768 to
 * test-results/screens/ for the `e2e-screens` artifact. The report row is read
 * back and printed (`[readback]`). Run in CI because the host was over the load
 * limit for a local dev server.
 */
test.use({ storageState: "e2e/.auth/admin.json" })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `e2e-t10a-${randomUUID().slice(0, 8)}`
const HOUR = 60 * 60 * 1000
const users: string[] = []
let eventId = ""
let roomId = ""
let bulkIds: string[] = []
const PAGE = 100

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u
}

test.afterAll(async () => {
  await db.message_reports.deleteMany({ where: { id: { in: bulkIds } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  if (roomId) {
    await db.chat_messages.deleteMany({ where: { chat_group_id: roomId } })
    await db.chat_group_members.deleteMany({ where: { chat_group_id: roomId } })
    await db.chat_groups.deleteMany({ where: { id: roomId } })
  }
  if (eventId) await db.events.deleteMany({ where: { id: eventId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

test("a deleted message's card keeps the reported words, and the threat comes first", async ({ page, baseURL }) => {
  const host = await person("host", "organizer")
  const author = await person("author")
  eventId = (
    await db.events.create({
      data: { slug: tag, title: `${tag} night`, description: "e2e fixture", start_time: new Date(Date.now() - HOUR), end_time: new Date(Date.now() + 3 * HOUR), timezone: "UTC", status: "published", organizer_id: host.id },
    })
  ).id
  roomId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: author.id, anonymous_name: `${tag} Pseudo A` } })

  // Oldest first by filing time, so only severity can put the threat on top.
  const filed: Record<string, { words: string; messageId: string; reportId: string }> = {}
  for (const [i, reason] of (["spam", "harassment", "threat"] as const).entries()) {
    const reporter = await person(`reporter-${reason}`)
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: reporter.id, anonymous_name: `${tag} Pseudo ${i}` } })
    const words = `${tag} ${reason}: ${reason === "threat" ? "I know where you live" : reason === "harassment" ? "why are you ignoring me" : "buy followers here"}`
    const message = await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: author.id, content: words } })

    const app = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${signAccessToken(reporter.id, reporter.email)}` } })
    const res = await app.post(`/api/mobile/messages/${message.id}/report`, { data: { messageType: "group", reason } })
    expect(res.status(), await res.text()).toBe(201)
    await app.dispose()

    const report = await db.message_reports.findFirstOrThrow({ where: { reporter_id: reporter.id, message_id: message.id } })
    await db.message_reports.update({ where: { id: report.id }, data: { created_at: new Date(Date.now() - (3 - i) * HOUR) } })
    filed[reason] = { words, messageId: message.id, reportId: report.id }
  }

  // The reported message is gone from the database, not only hidden.
  await db.chat_messages.delete({ where: { id: filed.threat.messageId } })
  expect(await db.chat_messages.count({ where: { id: filed.threat.messageId } })).toBe(0)

  // More than a page of one kind waiting: spam on messages that no longer exist, newer than the three above.
  const bulk = await person("bulk-reporter")
  bulkIds = Array.from({ length: PAGE + 1 }, () => randomUUID())
  await db.message_reports.createMany({
    data: bulkIds.map((id) => ({ id, reporter_id: bulk.id, message_id: randomUUID(), message_type: "group", reason: "spam", created_at: new Date(Date.now() - HOUR) })),
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/dashboard/moderation/reports")
  const main = page.getByRole("main")
  await expect(main.getByText("Showing the 100 most severe of each kind", { exact: true })).toBeVisible()
  await expect(page.getByText("What people reported about each other, most severe first, then oldest. Age is the SLA — 24 hours.")).toBeVisible()
  const footer = main.getByText(/^\d+ pending · most severe first, then oldest · decisions write to the audit log$/)
  await expect(footer).toBeVisible()
  const quotes = main.locator("blockquote")
  await expect(quotes.filter({ hasText: filed.threat.words })).toHaveCount(1)

  // The three in the order the queue shows them, among whatever else is waiting.
  const shown = (await quotes.allInnerTexts()).flatMap((q) =>
    (["threat", "harassment", "spam"] as const).filter((reason) => q.includes(filed[reason].words))
  )
  expect(shown).toEqual(["threat", "harassment", "spam"])

  await screens(page, 1280)
  await page.setViewportSize({ width: 768, height: 1024 })
  await expect(main.getByText("Showing the 100 most severe of each kind", { exact: true })).toBeVisible()
  await screens(page, 768)

  const [row] = await db.$queryRaw<{ reason: string; excerpt: string | null }[]>`
    SELECT reason, excerpt FROM message_reports WHERE id = ${filed.threat.reportId}::uuid`
  console.log(`[readback] SELECT reason, excerpt FROM message_reports WHERE id = '${filed.threat.reportId}' -> ${JSON.stringify(row)}`)
  expect(row).toEqual({ reason: "threat", excerpt: filed.threat.words })
})

/** The top of the Pending tab and its footer, at this width. */
async function screens(page: Page, width: number) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `test-results/screens/reports-queue-${width}-top.png` })
  await page.getByRole("main").getByText(/most severe first, then oldest/).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `test-results/screens/reports-queue-${width}-footer.png` })
}
