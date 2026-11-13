/*
 * Post-event insights outlive the purges (SCRUM-1051, step 4).
 *
 * The 30-day purge blanks Tonight's question answers and work intent; the
 * 180-day purge deletes Lobby posts, and their asks with them by cascade --
 * which is one of the three ways a connection is counted. Before either runs
 * on an event, its aggregate counts are frozen into `event_insight_tallies`
 * and the readers prefer the frozen figure, so the event's insights read the
 * same after the purge as before it. Counts only: never an id, never words.
 */
import { getConnectionMetrics, MIN_ATTENDEES } from "@/lib/connection-metrics"
import { db as appDb } from "@/lib/db"
import { freezeInsightTallies } from "@/lib/insight-tallies"
import { purgeClosedLobbies, purgeTonightAnswers, RETENTION_DAYS, TONIGHT_ANSWER_DAYS } from "@/lib/lobby-retention"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

const DAY = 86_400_000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

/** An event that ended `daysAgo` days ago, with `n` checked-in attendees. */
async function endedRoom(daysAgo: number, n = MIN_ATTENDEES) {
  const host = await makeUser("it-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const end = new Date(Date.now() - daysAgo * DAY)
  const start = new Date(end.getTime() - 3 * 3_600_000)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: end } })
  await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { start_time: start, end_time: end } })
  const occurrenceId = await occurrenceOf(eventId)
  const guests: string[] = []
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`it-g${i}`)
    users.push(u)
    guests.push(u)
    await db.event_check_ins.create({
      data: { user_id: u, event_id: eventId, occurrence_id: occurrenceId, check_in_time: start, status: "checked_out", kind: "attendee" },
    })
  }
  return { eventId, guests }
}

async function acceptedAsk(eventId: string, from: string, to: string) {
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: to, kind: "offer", body: "Two seats in the car", spaces_left: 2 } })
  await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: from, to_user_id: to, status: "accepted", decided_at: new Date() } })
}

const tallyOf = (eventId: string) => db.event_insight_tallies.findUnique({ where: { event_id: eventId } })

/** Every leaf of a JSON value. */
const leaves = (v: unknown): unknown[] => (v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v])

describe("the 30-day purge freezes the event's counts first", () => {
  it("records Tonight's answered count and the work-intent mix, then blanks the answers", async () => {
    const { eventId, guests } = await endedRoom(TONIGHT_ANSWER_DAYS + 1)
    await db.event_match_preferences.createMany({
      data: [
        { event_id: eventId, user_id: guests[0], tonight_answer: "the talks", work_intent: "hire" },
        { event_id: eventId, user_id: guests[1], tonight_answer: "the people", work_intent: "hire" },
        { event_id: eventId, user_id: guests[2], work_intent: "learn" },
      ],
    })

    for (let i = 0; i < 10 && !(await tallyOf(eventId)); i++) await purgeTonightAnswers()

    const tally = await tallyOf(eventId)
    expect(tally?.counts).toMatchObject({ tonight: { answered: 2, workIntent: { hire: 2, learn: 1, build: 0, find_work: 0 } } })
    // The rows behind it really went (the control: the figure is the tally's).
    expect(await db.event_match_preferences.count({ where: { event_id: eventId, OR: [{ tonight_answer: { not: null } }, { work_intent: { not: null } }] } })).toBe(0)
  })

  it("leaves an event inside the window alone (the control)", async () => {
    const { eventId } = await endedRoom(TONIGHT_ANSWER_DAYS - 1)
    await purgeTonightAnswers()
    await freezeInsightTallies(new Date(Date.now() - TONIGHT_ANSWER_DAYS * DAY))
    expect(await tallyOf(eventId)).toBeNull()
  })

  it("freezes once: a later pass does not rewrite it", async () => {
    const { eventId } = await endedRoom(TONIGHT_ANSWER_DAYS + 2)
    for (let i = 0; i < 10 && !(await tallyOf(eventId)); i++) await freezeInsightTallies(new Date(Date.now() - TONIGHT_ANSWER_DAYS * DAY))
    const first = await tallyOf(eventId)
    await freezeInsightTallies(new Date(Date.now() - TONIGHT_ANSWER_DAYS * DAY))
    expect((await tallyOf(eventId))?.frozen_at).toEqual(first?.frozen_at)
  })
})

describe("connections read the same after the 180-day purge", () => {
  it("keeps a Lobby connection once its post and ask are deleted", async () => {
    const { eventId, guests } = await endedRoom(RETENTION_DAYS + 2)
    await acceptedAsk(eventId, guests[0], guests[1])
    await db.event_waves.createMany({ data: [{ event_id: eventId, from_id: guests[2], to_id: guests[3] }, { event_id: eventId, from_id: guests[3], to_id: guests[2] }] })
    const before = await getConnectionMetrics(eventId)
    expect(before).toMatchObject({ connections: 2, connected: 4 })

    for (let i = 0; i < 10 && (await db.board_posts.count({ where: { event_id: eventId } })) > 0; i++) await purgeClosedLobbies(new Date(), "delete")

    // The control: the post and its ask are really gone, so the figure below is the tally's.
    expect(await db.board_requests.count({ where: { event_id: eventId } })).toBe(0)
    expect(await getConnectionMetrics(eventId)).toEqual(before)
    expect((await tallyOf(eventId))?.counts).toMatchObject({ lobby: { offer: 1, seeking: 0, chat: 0, asks: 1, accepted: 1 } })
  })

  it("never purges a Lobby before its event is frozen", async () => {
    const { eventId, guests } = await endedRoom(RETENTION_DAYS + 3)
    await acceptedAsk(eventId, guests[0], guests[1])
    // A freeze that fails leaves no tally; the purge must wait for one.
    await db.event_insight_tallies.deleteMany({ where: { event_id: eventId } })
    const spy = jest.spyOn(appDb.event_insight_tallies, "createMany").mockRejectedValue(new Error("boom"))
    try {
      await purgeClosedLobbies(new Date(), "delete")
    } finally {
      spy.mockRestore()
    }
    expect(await db.board_posts.count({ where: { event_id: eventId } })).toBe(1)
  })
})

describe("a tally is counts only", () => {
  it("holds no id, no name and no words", async () => {
    const { eventId, guests } = await endedRoom(TONIGHT_ANSWER_DAYS + 3)
    await db.event_match_preferences.create({ data: { event_id: eventId, user_id: guests[0], tonight_answer: "secret words", work_intent: "build" } })
    await acceptedAsk(eventId, guests[0], guests[1])
    for (let i = 0; i < 10 && !(await tallyOf(eventId)); i++) await freezeInsightTallies(new Date(Date.now() - TONIGHT_ANSWER_DAYS * DAY))

    const all = leaves((await tallyOf(eventId))?.counts)
    expect(all.length).toBeGreaterThan(0)
    for (const v of all) expect(typeof v).toBe("number")
  })
})
