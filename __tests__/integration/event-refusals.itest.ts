import { eventRefusals, GOOD_FIX_METRES } from "@/lib/check-in-refusals"
import { closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * The organiser's door verdict (SCRUM-196).
 *
 * Driven on staging: two people refused out of range at fixes of 5 m and 12 m,
 * and the event page said nothing. The verdict is the whole reason
 * `accuracy_metres` exists — a cluster at good fixes is the pin, a cluster at
 * poor fixes is the phones — so each of its four states gets a row shape that
 * produces exactly it, and people are counted rather than attempts.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.check_in_refusals.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

async function world() {
  const organiser = await makeUser(testId("er-org"), "organizer")
  const a = await makeUser(testId("er-a"))
  const b = await makeUser(testId("er-b"))
  const c = await makeUser(testId("er-c"))
  users.push(organiser, a, b, c)
  const eventId = await makeEvent(organiser)
  events.push(eventId)
  return { eventId, a, b, c }
}

describe("eventRefusals", () => {
  it("says 'fence' when every reported fix was good, and counts people not attempts", async () => {
    const { eventId, a, b } = await world()
    await db.check_in_refusals.createMany({
      data: [
        // a tried twice from the pavement at good fixes; b once, also good.
        { event_id: eventId, user_id: a, reason: "out_of_range", shortfall_metres: 40, accuracy_metres: 5 },
        { event_id: eventId, user_id: a, reason: "out_of_range", shortfall_metres: 38, accuracy_metres: 6 },
        { event_id: eventId, user_id: b, reason: "out_of_range", shortfall_metres: 845_253, accuracy_metres: 12 },
      ],
    })
    const r = await eventRefusals(eventId)
    expect(r.people).toBe(2)
    expect(r.attempts).toBe(3)
    expect(r.verdict).toBe("fence")
    expect(r.accuracy).toEqual({ min: 5, max: 12, count: 3 })
    expect(r.medianShortfallMetres).toBe(40)
    expect(r.byReason).toEqual([{ reason: "out_of_range", label: "Outside the fence", people: 2 }])
  })

  it("says 'phones' when every fix was poor — and the reason chips still list the others", async () => {
    const { eventId, a, b, c } = await world()
    await db.check_in_refusals.createMany({
      data: [
        { event_id: eventId, user_id: a, reason: "out_of_range", shortfall_metres: 30, accuracy_metres: GOOD_FIX_METRES + 30 },
        { event_id: eventId, user_id: b, reason: "out_of_range", shortfall_metres: 50, accuracy_metres: 140 },
        // c never reached the fence check: turned away on age. Not the pin's business.
        { event_id: eventId, user_id: c, reason: "under_age" },
      ],
    })
    const r = await eventRefusals(eventId)
    expect(r.people).toBe(3)
    expect(r.verdict).toBe("phones")
    expect(r.byReason.map((x) => [x.reason, x.people])).toEqual([
      ["out_of_range", 2],
      ["under_age", 1],
    ])
  })

  it("says 'mixed' when both, and nothing at all when no fix reported an accuracy", async () => {
    const mixed = await world()
    await db.check_in_refusals.createMany({
      data: [
        { event_id: mixed.eventId, user_id: mixed.a, reason: "out_of_range", shortfall_metres: 20, accuracy_metres: 8 },
        { event_id: mixed.eventId, user_id: mixed.b, reason: "out_of_range", shortfall_metres: 20, accuracy_metres: 120 },
      ],
    })
    expect((await eventRefusals(mixed.eventId)).verdict).toBe("mixed")

    // Rows from before the client sent accuracy at all (every refusal on
    // staging until 2026-09-21). The pin and the phones cannot be told apart.
    const legacy = await world()
    await db.check_in_refusals.createMany({
      data: [
        { event_id: legacy.eventId, user_id: legacy.a, reason: "out_of_range", shortfall_metres: 20 },
        { event_id: legacy.eventId, user_id: legacy.b, reason: "too_early" },
      ],
    })
    const r = await eventRefusals(legacy.eventId)
    expect(r.people).toBe(2)
    expect(r.verdict).toBeNull()
    expect(r.accuracy).toBeNull()
    expect(r.medianShortfallMetres).toBe(20)
  })

  it("counts a fix of exactly GOOD_FIX_METRES as good", async () => {
    // The footnote says "50 m or better"; the verdict must agree with it.
    const { eventId, a } = await world()
    await db.check_in_refusals.create({
      data: { event_id: eventId, user_id: a, reason: "out_of_range", shortfall_metres: 10, accuracy_metres: GOOD_FIX_METRES },
    })
    expect((await eventRefusals(eventId)).verdict).toBe("fence")
  })

  it("is empty for an event that turned nobody away", async () => {
    const { eventId } = await world()
    const r = await eventRefusals(eventId)
    expect(r).toEqual({
      people: 0,
      attempts: 0,
      byReason: [],
      medianShortfallMetres: null,
      accuracy: null,
      verdict: null,
    })
  })
})
