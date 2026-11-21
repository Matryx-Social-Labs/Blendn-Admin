/*
 * Person waves and the old likes go 30 days after the event's last night
 * (SCRUM-1094 c), against real rows: answered or not, once the event's insight
 * counts are frozen, so the host's "connections" survive the rows behind them.
 * A run whose latest night is inside the window keeps everything.
 */
import { GESTURE_DAYS, purgeEventGestures } from "@/lib/lobby-retention"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const DAY = 86_400_000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_waves.deleteMany({ where: { event_id: { in: events } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.event_insight_tallies.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

/** An event whose only occurrence ended `daysAgo` days ago. */
async function endedEvent(daysAgo: number, host: string) {
  const id = await makeEvent(host)
  events.push(id)
  const end = new Date(Date.now() - daysAgo * DAY)
  const start = new Date(end.getTime() - 3 * 3_600_000)
  await db.events.update({ where: { id }, data: { start_time: start, end_time: end } })
  await db.event_occurrences.updateMany({ where: { event_id: id }, data: { start_time: start, end_time: end } })
  return id
}

const gestures = async (event_id: string) => ({
  waves: await db.event_waves.count({ where: { event_id } }),
  likes: await db.event_likes.count({ where: { event_id } }),
})

let ana = ""
let ben = ""
let cat = ""
let old = ""
let recent = ""
let liveSeries = ""

beforeAll(async () => {
  const host = await makeUser(testId("wr-host"), "organizer")
  ana = await makeUser(testId("wr-ana"))
  ben = await makeUser(testId("wr-ben"))
  cat = await makeUser(testId("wr-cat"))
  users.push(host, ana, ben, cat)
  old = await endedEvent(GESTURE_DAYS + 1, host)
  recent = await endedEvent(GESTURE_DAYS - 1, host)
  // A run whose first night is long gone but whose latest night ended yesterday.
  liveSeries = await endedEvent(GESTURE_DAYS + 10, host)
  await db.event_occurrences.create({
    data: { event_id: liveSeries, occurs_on: new Date(Date.now() - DAY), start_time: new Date(Date.now() - DAY - 3_600_000), end_time: new Date(Date.now() - DAY) },
  })
  for (const event_id of [old, recent, liveSeries]) {
    const occurrenceId = await occurrenceOf(event_id)
    for (const userId of [ana, ben, cat]) await putInRoom({ eventId: event_id, occurrenceId, userId })
    // ana and ben waved at each other (a connection); cat waved at ana, unanswered; ben liked cat (an old like, unanswered).
    await db.event_waves.createMany({
      data: [
        { event_id, from_id: ana, to_id: ben },
        { event_id, from_id: ben, to_id: ana },
        { event_id, from_id: cat, to_id: ana },
      ],
    })
    await db.event_likes.create({ data: { event_id, liker_id: ben, liked_id: cat } })
  }
}, 60_000)

it("deletes every wave and like of an event whose last night ended over 30 days ago, after freezing its counts", async () => {
  expect(await db.event_insight_tallies.findUnique({ where: { event_id: old } })).toBeNull()
  const purged = await purgeEventGestures()
  expect(purged.waves).toBeGreaterThanOrEqual(3)
  expect(purged.likes).toBeGreaterThanOrEqual(1)
  expect(await gestures(old)).toEqual({ waves: 0, likes: 0 })
  // The host's connection count was frozen from the rows before they went.
  const tally = await db.event_insight_tallies.findUnique({ where: { event_id: old }, select: { counts: true } })
  expect((tally?.counts as { connections: { connections: number } }).connections.connections).toBe(1)
})

it("keeps an event inside the window, and a run whose latest night is (the negative controls)", async () => {
  await purgeEventGestures()
  expect(await gestures(recent)).toEqual({ waves: 3, likes: 1 })
  expect(await gestures(liveSeries)).toEqual({ waves: 3, likes: 1 })
})

it("waits for the counts: an event whose tally is missing keeps its rows", async () => {
  const host = users[0]
  const unfrozen = await endedEvent(GESTURE_DAYS + 2, host)
  await db.event_waves.create({ data: { event_id: unfrozen, from_id: ana, to_id: cat } })
  // As if its freeze had failed: the purge's own freeze does nothing, so no tally is written.
  let purge = purgeEventGestures
  jest.isolateModules(() => {
    jest.doMock("@/lib/insight-tallies", () => ({ freezeInsightTallies: async () => 0 }))
    purge = (require("@/lib/lobby-retention") as typeof import("@/lib/lobby-retention")).purgeEventGestures
  })
  const purged = await purge()
  expect(purged.waves).toBe(0)
  expect(await gestures(unfrozen)).toEqual({ waves: 1, likes: 0 })
})
