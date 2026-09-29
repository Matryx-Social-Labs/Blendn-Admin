/*
 * A night's rating is "only ever seen by us" (SCRUM-437).
 *
 * The app says so to everyone who rates the night, and the organiser's pages
 * printed "4 · 1 ratings" beside "1 came". These are the two readers the
 * overview tests don't reach: the post-event digest, and the ratings export,
 * which handed hosts every score with the second it was given.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { getFeedbackDigest } from "@/app/dashboard/events/[id]/feedback/actions"
import { canRunReport, reportsFor } from "@/lib/reports"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_ratings.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function ratedEvent(scores: number[]) {
  const host = await makeUser(testId("nr-host"), "organizer")
  const raters = await Promise.all(scores.map((_, i) => makeUser(testId(`nr-rater${i}`))))
  users.push(host, ...raters)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.event_ratings.createMany({
    data: scores.map((rating, i) => ({ event_id: eventId, user_id: raters[i], rating })),
  })
  return eventId
}

describe("the feedback digest", () => {
  beforeAll(async () => {
    const admin = await makeUser(testId("nr-admin"), "app_admin")
    users.push(admin)
    session = { user: { id: admin, role: "app_admin" } }
  })

  it("withholds the stars under five raters, and says how many there were", async () => {
    const digest = await getFeedbackDigest(await ratedEvent([4, 2]))
    expect(digest).toMatchObject({ averageRating: null, ratings: [0, 0, 0, 0, 0], ratingCount: 2 })
  })

  it("shows them from the fifth", async () => {
    const digest = await getFeedbackDigest(await ratedEvent([5, 4, 4, 3, 5]))
    expect(digest).toMatchObject({ averageRating: 4.2, ratings: [0, 0, 1, 2, 2], ratingCount: 5 })
  })
})

describe("the ratings export", () => {
  it("is the platform's alone: a row per score with its time can't be withheld in part", () => {
    expect(canRunReport("ratings", "organizer")).toBe(false)
    expect(canRunReport("ratings", "venue_owner")).toBe(false)
    expect(canRunReport("ratings", "app_admin")).toBe(true)
    expect(reportsFor("organizer").map((r) => r.key)).not.toContain("ratings")
  })
})
