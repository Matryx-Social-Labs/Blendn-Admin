/*
 * Tonight's question answers go 30 days after the event ends (owner,
 * 2026-11-10), against real rows: the answer is set NULL, the person's other
 * preferences and the row stay, and anything inside the window is untouched.
 * Not behind LOBBY_PURGE, and not held by a report: no report copies an answer.
 */
import { purgeTonightAnswers, TONIGHT_ANSWER_DAYS } from "@/lib/lobby-retention"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const DAY = 86_400_000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (previousMode === undefined) delete process.env.LOBBY_PURGE
  else process.env.LOBBY_PURGE = previousMode
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
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

const answer = async (event_id: string, user_id: string) =>
  db.event_match_preferences.findUnique({
    where: { event_id_user_id: { event_id, user_id } },
    select: { tonight_answer: true, intent: true, revealed: true },
  })

let previousMode: string | undefined
let host = ""
let person = ""
let reporter = ""
let old = ""
let recent = ""
let liveSeries = ""

beforeAll(async () => {
  host = await makeUser(testId("tq-host"), "organizer")
  person = await makeUser(testId("tq-person"))
  reporter = await makeUser(testId("tq-reporter"))
  users.push(host, person, reporter)
  old = await endedEvent(TONIGHT_ANSWER_DAYS + 1, host)
  recent = await endedEvent(TONIGHT_ANSWER_DAYS - 1, host)
  // A run whose first night is long gone but whose latest night ended yesterday.
  liveSeries = await endedEvent(TONIGHT_ANSWER_DAYS + 10, host)
  await db.event_occurrences.create({
    data: { event_id: liveSeries, occurs_on: new Date(Date.now() - DAY), start_time: new Date(Date.now() - DAY - 3_600_000), end_time: new Date(Date.now() - DAY) },
  })
  for (const event_id of [old, recent, liveSeries]) {
    await db.event_match_preferences.create({
      data: { event_id, user_id: person, intent: ["friendship"], revealed: true, tonight_answer: `answer for ${event_id}` },
    })
  }
  // A pending report on the person: it quotes no answer, so it holds none.
  await db.user_reports.create({ data: { reporter_id: reporter, reported_id: person, reason: "harassment" } })

  previousMode = process.env.LOBBY_PURGE
  process.env.LOBBY_PURGE = "off"
})

describe("the answer purge", () => {
  let pass: Awaited<ReturnType<typeof purgeTonightAnswers>>

  beforeAll(async () => {
    pass = await purgeTonightAnswers()
  })

  it("clears the answer of an event that ended more than 30 days ago, whatever LOBBY_PURGE says and with a report open", async () => {
    expect(await answer(old, person)).toEqual({ tonight_answer: null, intent: ["friendship"], revealed: true })
    expect(pass.answers).toBeGreaterThanOrEqual(1)
  })

  it("keeps the answer of an event that ended inside the window (the control)", async () => {
    expect((await answer(recent, person))?.tonight_answer).toBe(`answer for ${recent}`)
  })

  it("keeps the answer while any night of the event ended inside the window", async () => {
    expect((await answer(liveSeries, person))?.tonight_answer).toBe(`answer for ${liveSeries}`)
  })

  it("is idempotent: a second pass finds nothing of these", async () => {
    await purgeTonightAnswers()
    expect((await answer(recent, person))?.tonight_answer).toBe(`answer for ${recent}`)
    expect((await answer(old, person))?.tonight_answer).toBeNull()
  })
})
