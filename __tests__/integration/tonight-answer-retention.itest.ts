/*
 * Tonight's question answers go 30 days after the event ends (owner,
 * 2026-11-10), against real rows: the answer is set NULL, the person's other
 * preferences and the row stay, and anything inside the window is untouched.
 * Not held by a report: no report copies an answer.
 */
import { purgeTonightAnswers, TONIGHT_ANSWER_DAYS } from "@/lib/lobby-retention"
import { addPastNight, cleanup, closeDb, db, endedEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

const answer = async (event_id: string, user_id: string) =>
  db.event_match_preferences.findUnique({
    where: { event_id_user_id: { event_id, user_id } },
    select: { tonight_answer: true, work_intent: true, intent: true, revealed: true },
  })

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
  old = await endedEvent(host, TONIGHT_ANSWER_DAYS + 1)
  events.push(old)
  recent = await endedEvent(host, TONIGHT_ANSWER_DAYS - 1)
  events.push(recent)
  // A run whose first night is long gone but whose latest night ended yesterday.
  liveSeries = await endedEvent(host, TONIGHT_ANSWER_DAYS + 10)
  events.push(liveSeries)
  await addPastNight(liveSeries, 1)
  for (const event_id of [old, recent, liveSeries]) {
    await db.event_match_preferences.create({
      data: { event_id, user_id: person, intent: ["friendship"], revealed: true, tonight_answer: `answer for ${event_id}`, work_intent: "hire" },
    })
  }
  // Why they were here (the work lens), with no answer beside it: cleared on its own too.
  await db.event_match_preferences.create({ data: { event_id: old, user_id: reporter, work_intent: "learn" } })
  // A pending report on the person: it quotes no answer, so it holds none.
  await db.user_reports.create({ data: { reporter_id: reporter, reported_id: person, reason: "harassment" } })
})

describe("the answer purge", () => {
  let pass: Awaited<ReturnType<typeof purgeTonightAnswers>>

  beforeAll(async () => {
    pass = await purgeTonightAnswers()
  })

  it("clears the answer of an event that ended more than 30 days ago, with a report open", async () => {
    expect(await answer(old, person)).toEqual({ tonight_answer: null, work_intent: null, intent: ["friendship"], revealed: true })
    expect((await answer(old, reporter))?.work_intent).toBeNull()
    expect(pass.answers).toBeGreaterThanOrEqual(1)
  })

  it("keeps the answer of an event that ended inside the window (the control)", async () => {
    expect((await answer(recent, person))?.tonight_answer).toBe(`answer for ${recent}`)
    expect((await answer(recent, person))?.work_intent).toBe("hire")
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
