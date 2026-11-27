import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

import { buildLiveSnapshot } from "../lib/live-snapshot"

/**
 * SCRUM-1285 driven: a complaint category one person wrote most of is held
 * back. An organisation's night ended an hour ago in a room of 14. entry_queue
 * is 25 messages from 5 people, one of whom wrote 20; crowding is 10 from 5
 * people, two each; facilities is two people's. The event's Feedback tab,
 * as the organizer, at 1280 and 768: entry_queue reads "<5" exactly as the
 * two-person facilities row does (the host is never told why), crowding reads 10,
 * the page carries no reason, and nothing is wider than the viewport. The live
 * snapshot a host's socket is sent (`ops:snapshot`) holds it back too. The
 * task's SELECT is read back and printed. Run in CI because the host was over
 * the load limit for a local dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
// No "dominance" in the tag: it is in the title and slug, and the page is searched for that word.
const tag = `e2e-t08-${randomUUID().slice(0, 8)}`
const WIDTHS = [1280, 768] as const
const HOUR = 60 * 60 * 1000

const users: string[] = []
let owner = ""
let orgId = ""
let eventId = ""
let roomId = ""
// SCRUM-1441: a second night with exactly one category held beside a shown one.
let rangeEventId = ""
let rangeRoomId = ""
let browser: Browser

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

/** `messages[i]` messages of `sentiment` in `category` from `people[i]`, in the first night unless `night` says otherwise. */
async function wrote(
  people: string[],
  category: "entry_queue" | "crowding" | "facilities" | "other",
  messages: number[],
  sentiment: "negative" | "positive" | "neutral" = "negative",
  night = { event: eventId, room: roomId }
) {
  for (const [i, n] of messages.entries()) {
    for (let k = 0; k < n; k++) {
      const m = await db.chat_messages.create({ data: { chat_group_id: night.room, user_id: people[i], content: `${tag} ${category} ${k}` } })
      await db.event_feedback.create({ data: { event_id: night.event, message_id: m.id, sentiment, category, confidence: 0.9, source: "lexicon" } })
    }
  }
}

/** An ended night of the org's with a room of 14; returns its event, its room and the members. */
async function night(title: string) {
  const end = new Date(Date.now() - HOUR)
  const start = new Date(end.getTime() - 4 * HOUR)
  const event = (
    await db.events.create({
      data: { slug: `${tag}-${randomUUID().slice(0, 4)}`, title, description: "e2e fixture", start_time: start, end_time: end, timezone: "UTC", status: "published", organizer_id: owner, organizer_org_id: orgId },
    })
  ).id
  await db.event_occurrences.create({ data: { event_id: event, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  const room = (await db.chat_groups.create({ data: { event_id: event, name: "room" }, select: { id: true } })).id
  const members: string[] = []
  for (let i = 0; i < 14; i++) {
    const id = await person(`${title.length}-m${i}`)
    members.push(id)
    await db.chat_group_members.create({ data: { chat_group_id: room, user_id: id, anonymous_name: `${tag} Pseudo ${i}` } })
  }
  return { event, room, members }
}

async function sessionFor(baseURL: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub: owner, role: "organizer" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
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

test.beforeAll(async () => {
  browser = await chromium.launch()
  owner = await person("owner", "organizer")
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const end = new Date(Date.now() - HOUR)
  const start = new Date(end.getTime() - 4 * HOUR)
  eventId = (
    await db.events.create({
      data: { slug: tag, title: `${tag} night`, description: "e2e fixture", start_time: start, end_time: end, timezone: "UTC", status: "published", organizer_id: owner, organizer_org_id: orgId },
    })
  ).id
  await db.event_occurrences.create({ data: { event_id: eventId, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  roomId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room" }, select: { id: true } })).id
  const members: string[] = []
  for (let i = 0; i < 14; i++) {
    const id = await person(`m${i}`)
    members.push(id)
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: id, anonymous_name: `${tag} Pseudo ${i}` } })
  }
  await wrote(members.slice(0, 5), "entry_queue", [20, 2, 1, 1, 1])
  await wrote(members.slice(5, 10), "crowding", [2, 2, 2, 2, 2])
  await wrote(members.slice(10, 12), "facilities", [1, 1])

  // 25 positive, 9 neutral, 27 negative: entry_queue 20 from 5 people, one with 16 (held); crowding 7 from 5 (shown).
  // A three-line title for the long-text proof.
  const r = await night(`${tag} Thiruvananthapuram Indie Makers' Late-Night Flea, Food and Vinyl Swap: Winter Edition at the Old Harbour Warehouse`)
  rangeEventId = r.event
  rangeRoomId = r.room
  const at = { event: r.event, room: r.room }
  await wrote(r.members.slice(0, 5), "other", [5, 5, 5, 5, 5], "positive", at)
  await wrote(r.members.slice(10, 13), "other", [3, 3, 3], "neutral", at)
  await wrote(r.members.slice(0, 5), "entry_queue", [16, 1, 1, 1, 1], "negative", at)
  await wrote(r.members.slice(5, 10), "crowding", [2, 2, 1, 1, 1], "negative", at)
})

test.afterAll(async () => {
  await browser.close()
  const events = [eventId, rangeEventId].filter(Boolean)
  const rooms = [roomId, rangeRoomId].filter(Boolean)
  await db.event_feedback.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_messages.deleteMany({ where: { chat_group_id: { in: rooms } } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: rooms } } })
  await db.chat_groups.deleteMany({ where: { id: { in: rooms } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

/** Nothing on the page is wider than the viewport. */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/** One category's row in "What went wrong", by its label. */
const row = (page: Page, label: string) => page.locator("span", { hasText: new RegExp(`^${label}$`) }).filter({ visible: true }).first().locator("..")

test("the Feedback tab holds back the category one person dominates, as it does one under the floor", async ({ baseURL }) => {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const page = await ctx.newPage()
    await page.goto(`/dashboard/events/${eventId}/feedback`)
    await expect(page.getByRole("heading", { name: "What went wrong" }).filter({ visible: true }).first()).toBeVisible()

    await expect(row(page, "crowding")).toContainText("10")
    await expect(row(page, "entry queue")).toContainText("<5")
    await expect(row(page, "entry queue")).not.toContainText("25")
    // Same words and markup as the two-person row under the floor, apart from the name.
    const shape = async (label: string) => (await row(page, label).innerHTML()).replace(label, "X")
    expect(await shape("entry queue")).toBe(await shape("facilities"))
    // The page and its payload carry no reason.
    const html = await page.content()
    expect(html).not.toContain("suppressionReason")
    expect(html).not.toContain("dominance")
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }

  // The live snapshot a host's socket is sent for the same event.
  const snapshot = (await buildLiveSnapshot(eventId))!
  expect(snapshot.categories.find((c) => c.category === "entry_queue")).toEqual({ category: "entry_queue", count: null, suppressed: true })
  expect(snapshot.categories.find((c) => c.category === "crowding")).toEqual({ category: "crowding", count: 10, suppressed: false })
  expect(JSON.stringify(snapshot)).not.toMatch(/suppressionReason|dominance/)

  // The read-back. The task's SELECT names `event_feedback.user_id`, which does not exist: the author is the message's.
  for (const category of ["entry_queue", "crowding"] as const) {
    const rows = await db.$queryRaw<{ user_id: string; count: bigint }[]>`
      SELECT m.user_id, count(*) FROM event_feedback f JOIN chat_messages m ON m.id = f.message_id
      WHERE f.event_id = ${eventId}::uuid AND f.category = ${category}::issue_category GROUP BY 1 ORDER BY 2 DESC`
    const counts = rows.map((r) => Number(r.count))
    console.log(`READBACK ${category} ${JSON.stringify({ event: eventId, rows: counts })}`)
    expect(counts).toEqual(category === "entry_queue" ? [20, 2, 1, 1, 1] : [2, 2, 2, 2, 2])
  }
})

/**
 * SCRUM-1441 driven (register D-012): with exactly one category held, negative 27 minus the shown crowding 7 would be
 * the held entry_queue's 20. As the organizer at 1280 and 768, the Feedback tab and the Overview's mood panel show the
 * negatives as 23–27 and the total as 57–61, and no figure on either panel is 20, 27 or 61 on its own; the live
 * snapshot a host's socket is sent carries the same band, and its mood alert says the bands. The read-back is printed.
 */
test("one held category: the negatives and the total are a band, and nothing gives the held count back", async ({ baseURL }) => {
  // A figure standing alone, not the end of a band ("23–27" is a band; "27" alone is the exact count).
  const alone = (n: number) => new RegExp(`(?<![\\d–,])${n}(?![\\d–,])`)
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const page = await ctx.newPage()

    await page.goto(`/dashboard/events/${rangeEventId}/feedback`)
    const split = page.locator("p", { hasText: "negatives are the takeaway" }).filter({ visible: true }).first().locator("..")
    await expect(split).toContainText("23–27 negative")
    await expect(split).toContainText("25 positive")
    await expect(split).toContainText("9 neutral")
    await expect(split).toContainText("7 of 23–27")
    await expect(page.getByText(/· 57–61 messages/).filter({ visible: true }).first()).toBeVisible()
    await expect(row(page, "crowding")).toContainText("7")
    await expect(row(page, "entry queue")).toContainText("<5")
    for (const n of [20, 27, 61]) expect(await split.innerText(), `${n} alone on the Feedback split at ${width}`).not.toMatch(alone(n))
    expect(await overflow(page), `Feedback overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/screens/held-count-range-feedback-${width}.png`, fullPage: true })

    await page.goto(`/dashboard/events/${rangeEventId}`)
    const mood = page.getByText("Mood — whole night").filter({ visible: true }).first().locator("xpath=ancestor::section[1]")
    await expect(mood).toContainText("23–27 negative")
    await expect(mood).toContainText("57–61 classified msgs")
    for (const n of [20, 27, 61]) expect(await mood.innerText(), `${n} alone on the mood panel at ${width}`).not.toMatch(alone(n))
    expect(await overflow(page), `Overview overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/screens/held-count-range-overview-${width}.png`, fullPage: true })
    await ctx.close()
  }

  // The live snapshot a host's socket is sent: the band, never the exact count, and the alert says the bands.
  const snapshot = (await buildLiveSnapshot(rangeEventId))!
  expect(snapshot.sentiment).toEqual({ positive: 25, neutral: 9, negative: { min: 23, max: 27 } })
  expect(JSON.stringify(snapshot)).not.toMatch(/"negative":27\b/)
  expect(snapshot.alerts.find((a) => a.kind === "mood_sliding")?.body).toBe("23–27 of 57–61 classified messages in the last 30 minutes are negative.")

  // The read-back: the negatives per category the band hides one of.
  const rows = await db.$queryRaw<{ category: string; count: bigint }[]>`
    SELECT f.category::text AS category, count(*) FROM event_feedback f
    WHERE f.event_id = ${rangeEventId}::uuid AND f.sentiment = 'negative' GROUP BY 1 ORDER BY 1`
  const counts = Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]))
  console.log(`READBACK negatives ${JSON.stringify({ event: rangeEventId, counts, shown: { negative: "23–27", total: "57–61" } })}`)
  expect(counts).toEqual({ crowding: 7, entry_queue: 20 })
})
