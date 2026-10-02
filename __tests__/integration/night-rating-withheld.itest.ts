/*
 * A night's rating is "only ever seen by us" (SCRUM-437).
 *
 * The app says so to everyone who rates the night, and the organiser's pages
 * printed "4 · 1 ratings" beside "1 came". These are the two readers the
 * overview tests don't reach: the post-event digest, and the ratings export,
 * which handed hosts every score with the second it was given.
 */
import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { buildReport, canRunReport, reportsFor } from "@/lib/reports"
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

/** The digest as the page builds it, from the event its loader read. */
async function digest(eventId: string, view: "host" | "venue") {
  const event = await db.events.findUniqueOrThrow({
    where: { id: eventId },
    select: { id: true, title: true, end_time: true, timezone: true },
  })
  return buildFeedbackDigest(event, view)
}

describe("the feedback digest", () => {
  it("withholds the stars under five raters, and says how many there were", async () => {
    expect(await digest(await ratedEvent([4, 2]), "host")).toMatchObject({
      averageRating: null,
      ratings: [0, 0, 0, 0, 0],
      ratingCount: 2,
    })
  })

  it("shows them from the fifth", async () => {
    expect(await digest(await ratedEvent([5, 4, 4, 3, 5]), "host")).toMatchObject({
      averageRating: 4.2,
      ratings: [0, 0, 1, 2, 2],
      ratingCount: 5,
    })
  })

  it("tells a venue no count of raters under the floor, and the count from it (step 15)", async () => {
    expect((await digest(await ratedEvent([4, 2]), "venue")).ratingCount).toBeNull()
    expect((await digest(await ratedEvent([5, 4, 4, 3, 5]), "venue")).ratingCount).toBe(5)
  })
})

describe("the feedback digest, as a venue reads another host's night (step 15)", () => {
  /** A night with `n` classified messages, one person each, of the given moods. */
  async function night(moods: Array<"positive" | "neutral" | "negative">) {
    const host = await makeUser(testId("fd-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
    for (const sentiment of moods) {
      const person = await makeUser(testId("fd-p"))
      users.push(person)
      await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: person, anonymous_name: testId("Fox") } })
      const message = await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: person, content: "the queue" } })
      await db.event_feedback.create({
        data: { event_id: eventId, message_id: message.id, sentiment, category: "entry_queue", confidence: 0.9, source: "lexicon" },
      })
    }
    return eventId
  }

  it("holds back the split, the total and the issue count under five", async () => {
    const eventId = await night(["negative", "negative", "positive"])
    const venue = await digest(eventId, "venue")
    expect(venue).toMatchObject({ view: "venue", total: null, counts: { positive: null, neutral: null, negative: null } })
    expect(venue.categories.every((c) => c.count === null && c.suppressed)).toBe(true)
    // The organiser reads the same night exactly.
    const host = await digest(eventId, "host")
    expect(host).toMatchObject({ view: "host", total: 3, counts: { positive: 1, neutral: 0, negative: 2 } })
  })

  it("shows a venue a total from five, each mood under five still held back, and zero as zero", async () => {
    const venue = await digest(await night(["negative", "negative", "negative", "negative", "negative", "positive"]), "venue")
    expect(venue.total).toBe(6)
    expect(venue.counts).toEqual({ positive: null, neutral: 0, negative: 5 })
  })
})

describe("the ratings export", () => {
  it("is the platform's alone: a row per score with its time can't be withheld in part", () => {
    expect(canRunReport("ratings", "organizer")).toBe(false)
    expect(canRunReport("ratings", "venue_owner")).toBe(false)
    expect(canRunReport("ratings", "app_admin")).toBe(true)
    expect(reportsFor("organizer").map((r) => r.key)).not.toContain("ratings")
  })

  it("is refused by buildReport itself, not only by the route in front of it", async () => {
    const range = { key: "custom" as const, from: new Date(0), to: new Date() }
    await expect(buildReport("ratings", "organizer", "anyone", range)).rejects.toThrow(/not open to organizer/)
  })
})
