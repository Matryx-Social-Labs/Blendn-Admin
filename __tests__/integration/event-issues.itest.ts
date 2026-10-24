import { recordIssuesFor, issuesFor, liveEventIds } from "@/lib/event-issues"

import { sqlCounter } from "./sql-count"

import { db, closeDb, makeUser, makeEvent, occurrenceOf, testId, putInRoom } from "./helpers"

/**
 * Alerts that outlive the tab.
 *
 * `deriveAlerts` is pure, correct, and had exactly one caller: a `useMemo` in
 * the live tab. So the seven rules produced warnings that existed only while
 * somebody had that screen open — an `over_capacity` breach at 23:40 was gone
 * at 23:45, with no record it had happened, on the screen a venue's
 * crowd-safety decisions come from.
 *
 * Needs a real database: the invariant that makes a sweep-on-a-timer safe is a
 * partial unique index, and `schema.prisma` cannot express one — so a mocked
 * client would happily accept the duplicate rows this exists to prevent.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_issues.deleteMany({ where: { event_id: { in: events } } })
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** A live event whose room is over its stated capacity. */
async function overCrowded(capacity = 2, guests = 5) {
  const host = await makeUser(testId("iss-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)

  const now = new Date()
  await db.events.update({
    where: { id: eventId },
    data: {
      max_capacity: capacity,
      start_time: new Date(now.getTime() - 60 * 60 * 1000),
      end_time: new Date(now.getTime() + 60 * 60 * 1000),
      status: "published",
    },
  })

  const occurrenceId = await occurrenceOf(eventId)
  for (let i = 0; i < guests; i++) {
    const u = await makeUser(testId(`iss-g${i}`))
    users.push(u)
    await putInRoom({ eventId, occurrenceId, userId: u })
  }
  return { eventId, occurrenceId }
}

describe("issues are recorded whether or not anyone is watching", () => {
  it("opens one when a rule fires", async () => {
    const { eventId } = await overCrowded()

    const r = await recordIssuesFor(eventId)
    expect(r.opened).toBeGreaterThan(0)

    const rows = await issuesFor(eventId)
    const breach = rows.find((i) => i.kind === "over_capacity")
    expect(breach).toBeDefined()
    expect(breach!.severity).toBe("critical")
    expect(breach!.resolvedAt).toBeNull()
    // The wording as it fired, not re-derived later from numbers that moved.
    expect(breach!.body).toContain("over")
  })

  it("bumps rather than duplicating while the condition persists", async () => {
    const { eventId } = await overCrowded()

    await recordIssuesFor(eventId)
    const second = await recordIssuesFor(eventId, new Date(Date.now() + 60_000))

    expect(second.opened).toBe(0)
    expect(second.stillOpen).toBeGreaterThan(0)

    /*
     * The point of the partial unique. A sweep every minute would otherwise
     * write a row a minute, and an hour-long queue would be sixty identical
     * alerts — a feed people learn to scroll past.
     */
    const all = await db.event_issues.count({
      where: { event_id: eventId, kind: "over_capacity" },
    })
    expect(all).toBe(1)

    const [row] = await issuesFor(eventId)
    expect(new Date(row.lastSeenAt).getTime()).toBeGreaterThan(new Date(row.openedAt).getTime())
  })

  it("resolves when the condition stops, and keeps the record", async () => {
    const { eventId } = await overCrowded()
    await recordIssuesFor(eventId)

    // The room empties: every session closes, so nobody is inside.
    await db.presence_sessions.updateMany({
      where: { event_id: eventId },
      data: { departed_at: new Date(), departed_source: "user" },
    })

    await recordIssuesFor(eventId, new Date(Date.now() + 120_000))

    const rows = await issuesFor(eventId)
    const breach = rows.find((i) => i.kind === "over_capacity")
    // Still there — resolved is not deleted, because "it cleared itself twenty
    // minutes ago" is the useful thing to be able to say.
    expect(breach).toBeDefined()
    expect(breach!.resolvedAt).not.toBeNull()
  })

  it("can open the same kind again on a later night", async () => {
    /*
     * The partial unique is scoped to OPEN issues. Once resolved, the same
     * condition recurring is a new issue rather than a constraint violation —
     * which a plain unique would have made impossible.
     */
    const { eventId } = await overCrowded()
    await recordIssuesFor(eventId)
    await db.event_issues.updateMany({
      where: { event_id: eventId },
      data: { resolved_at: new Date() },
    })

    const again = await recordIssuesFor(eventId, new Date(Date.now() + 180_000))
    expect(again.opened).toBeGreaterThan(0)
    expect(
      await db.event_issues.count({ where: { event_id: eventId, kind: "over_capacity" } })
    ).toBe(2)
  })
})

describe("which events are live", () => {
  async function eventAt(host: string, start: Date, end: Date, status: "published" | "draft" = "published") {
    const id = await makeEvent(host)
    events.push(id)
    await db.events.update({ where: { id }, data: { start_time: start, end_time: end, status } })
    return id
  }

  it("is the published events running now, earliest start first, capped — read without an ORDER BY … LIMIT the planner would walk history for", async () => {
    const host = await makeUser(testId("iss-live-host"), "organizer")
    users.push(host)
    const now = new Date()
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
    const third = await eventAt(host, at(-30), at(60))
    const first = await eventAt(host, at(-180), at(60))
    const second = await eventAt(host, at(-90), at(60))
    const ended = await eventAt(host, at(-300), at(-10))
    const ahead = await eventAt(host, at(10), at(120))
    const draft = await eventAt(host, at(-60), at(60), "draft")

    const counter = sqlCounter()
    try {
      const { result, sql } = await counter.during(() => liveEventIds(now, 100_000))
      expect(result.filter((id) => [first, second, third, ended, ahead, draft].includes(id))).toEqual([first, second, third])
      expect(sql.filter((s) => /FROM "public"."events"/.test(s)).every((s) => !/LIMIT/.test(s) && !/ORDER BY/.test(s))).toBe(true)
    } finally {
      await counter.stop()
    }
    // The cap keeps the earliest, whoever else is live in this database.
    const all = await liveEventIds(now, 100_000)
    expect(await liveEventIds(now, 2)).toEqual(all.slice(0, 2))
  })
})
