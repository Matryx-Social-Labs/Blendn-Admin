/*
 * The App Review seed's demo event (SCRUM-976). On a database with no upcoming event the seed creates one, and wrote
 * its occurrences twice: `syncOccurrences`, then a hand-rolled `createMany` of the same days, which @@unique(event_id,
 * occurs_on) refuses. The seed died after creating the event, leaving the reviewer's event with its rows half-made.
 */
import { createReviewDemoEvent } from "@/scripts/seed-review-account"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanup(users, [])
  await closeDb()
})

describe("the review seed's demo event", () => {
  it("is created with one set of occurrences, so the seed runs to the end", async () => {
    const organizer = await makeUser("rv-org", "organizer")
    users.push(organizer)
    const { event, occurrences } = await createReviewDemoEvent(db, organizer, testId("rv"))
    events.push(event.id)
    expect(occurrences).toBeGreaterThan(0)
    expect(await db.event_occurrences.count({ where: { event_id: event.id } })).toBe(occurrences)
  })
})
