/*
 * One retention pass drains a backlog many times the batch size (SCRUM-1224, launch gate 3).
 *
 * The sweep deleted at most one batch of 5,000 notifications and 5,000 product events per six-hour pass, then only
 * logged `hadMore`: a ceiling of 20,000 rows a day per table, which bell rows (one per recipient per push, thousands
 * per announcement) pass within weeks of launch. Now each pass loops while a batch comes back full.
 *
 * Every date here is an offset from the real clock, never a calendar day, so the run means the same thing at any hour
 * (SCRUM-1382: two retention suites fail 00:00-01:00 UTC because they compare day keys).
 */
import { PRODUCT_EVENTS } from "@/lib/product-events"
import { runSweep } from "@/lib/notification-retention"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const DAY = 24 * 60 * 60 * 1000
const BACKLOG = 12_000 // more than two full batches of 5,000
const KEPT = 100
const CHUNK = 2_000 // createMany under Postgres's 65,535 bind parameters

jest.setTimeout(120_000)

const users: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.product_events.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  return id
}

const ago = (days: number) => new Date(Date.now() - days * DAY)

async function inChunks(total: number, insert: (from: number, count: number) => Promise<unknown>) {
  for (let from = 0; from < total; from += CHUNK) await insert(from, Math.min(CHUNK, total - from))
}

async function bell(userId: string, total: number, at: { created: Date; read: Date | null }) {
  await inChunks(total, (_, count) =>
    db.notifications.createMany({
      data: Array.from({ length: count }, () => ({
        user_id: userId,
        kind: "announcement" as const,
        title: "t",
        body: "Posted an announcement",
        created_at: at.created,
        read_at: at.read,
      })),
    })
  )
}

describe("a notification backlog", () => {
  it("one sweep removes 12,000 read rows past 30 days and keeps the 100 read yesterday", async () => {
    const user = await person("drain-bell")
    await bell(user, BACKLOG, { created: ago(41), read: ago(40) })
    await bell(user, KEPT, { created: ago(2), read: ago(1) })

    await runSweep()

    const stale = await db.notifications.count({ where: { user_id: user, read_at: { lt: ago(30) } } })
    const kept = await db.notifications.count({ where: { user_id: user } })
    expect(stale).toBe(0)
    expect(kept).toBe(KEPT)
  })

  it("keeps an unread row until 90 days, then removes it", async () => {
    const user = await person("drain-unread")
    await bell(user, 3, { created: ago(100), read: null })
    await bell(user, 2, { created: ago(40), read: null })

    await runSweep()

    const left = await db.notifications.findMany({ where: { user_id: user }, select: { created_at: true } })
    expect(left).toHaveLength(2)
    for (const row of left) expect(row.created_at.getTime()).toBeGreaterThan(ago(90).getTime())
  })
})

describe("a product-event backlog", () => {
  it("one sweep removes 12,000 events past 180 days and keeps the 100 from yesterday", async () => {
    const user = await person("drain-pe")
    const tag = testId("pe")
    const events = (total: number, at: Date, key: string) =>
      inChunks(total, (from, count) =>
        db.product_events.createMany({
          data: Array.from({ length: count }, (_, i) => ({
            user_id: user,
            name: PRODUCT_EVENTS.app_opened,
            occurred_at: at,
            dedupe_key: `${tag}:${key}:${from + i}`,
          })),
        })
      )
    await events(BACKLOG, ago(181), "old")
    await events(KEPT, ago(1), "new")

    await runSweep()

    const stale = await db.product_events.count({ where: { user_id: user, occurred_at: { lt: ago(180) } } })
    const kept = await db.product_events.count({ where: { user_id: user } })
    expect(stale).toBe(0)
    expect(kept).toBe(KEPT)
  })
})
