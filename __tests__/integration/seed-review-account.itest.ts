/*
 * The App Review seed (`npm run seed:review`), run as the operator runs it: the script itself, against this database.
 *
 * Launch gate 6 (SCRUM-1196): a reviewer anywhere must have an event to enter, and real users must never see it. The
 * seed used to make its event only when nothing upcoming was published, so on a populated production there was none;
 * it ran 4 h starting 26 h after the run, so the door was open for about 5.5 h of a review that takes days; and it was
 * public. Now there is always exactly one, `review-demo-event`, unlisted, open around the clock for a week from the
 * run, found through the link the script prints. That an unlisted event stays out of the feed and search is
 * discovery-visibility.itest.ts; the review account's geofence bypass at it is review-accounts.itest.ts.
 */
import { spawnSync } from "child_process"

import { attendeeEventAccess } from "@/lib/event-door"
import { eventShareUrl } from "@/lib/event-share"
import { pickOccurrence, resolveOccurrence } from "@/lib/occurrences"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const SLUG = "review-demo-event"
const HOUR = 60 * 60 * 1000
const email = `${testId("rv")}@itest.invalid`
const users: string[] = []
const events: string[] = []
let preexisting = false

/** The script, as `npm run seed:review` runs it. Its stdout, or the test fails with its stderr. */
function seed(): string {
  const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/seed-review-account.ts"], {
    env: { ...process.env, APP_REVIEW_EMAIL: email, APP_REVIEW_PASSWORD: "Rooftop-Correct-Horse-26" },
    encoding: "utf8",
    timeout: 60_000,
  })
  if (run.status !== 0) throw new Error(`seed:review exited ${run.status}: ${run.stderr}`)
  return run.stdout
}

const reviewEvent = () => db.events.findMany({ where: { slug: SLUG } })

beforeAll(async () => {
  preexisting = (await reviewEvent()).length > 0
  // One real upcoming public event: the state of a populated production.
  const organizer = await makeUser("rv-org", "organizer")
  users.push(organizer)
  const real = await db.events.create({
    data: {
      slug: testId("rv-real"),
      title: "A real upcoming event",
      description: "integration fixture",
      start_time: new Date(Date.now() + 24 * HOUR),
      end_time: new Date(Date.now() + 27 * HOUR),
      timezone: "Asia/Kolkata",
      city: "Bengaluru",
      status: "published",
      visibility: "public",
      organizer_id: organizer,
    },
  })
  events.push(real.id)
})

afterAll(async () => {
  const reviewer = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (reviewer) users.push(reviewer.id)
  const demo = preexisting ? [] : (await reviewEvent()).map((e) => e.id)
  await db.event_occurrences.deleteMany({ where: { event_id: { in: [...events, ...demo] } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [...events, ...demo])
  await closeDb()
})

describe("seed:review on a database with real upcoming events", () => {
  let printed: string

  beforeAll(() => {
    printed = seed()
  })

  it("creates the review event anyway, unlisted, and prints the link the app's Share button makes", async () => {
    const [event] = await reviewEvent()
    expect(event).toMatchObject({ status: "published", visibility: "unlisted", review_demo: true, deleted_at: null })
    expect(printed).toContain(event.id)
    expect(printed).toContain(eventShareUrl(event.id))
  })

  it("keeps the door open at every hour of the week from the run", async () => {
    const [event] = await reviewEvent()
    const { slots } = await resolveOccurrence(event.id)
    const now = Date.now()
    const closed = []
    for (let at = now; at <= now + 7 * 24 * HOUR - 2 * HOUR; at += HOUR) {
      if (!pickOccurrence(slots, new Date(at)).ok) closed.push(new Date(at).toISOString())
    }
    expect(closed).toEqual([])
    expect(pickOccurrence(slots, new Date(now + 2 * 24 * HOUR)).ok).toBe(true)
  })

  it("opens by id for the review account and for anybody holding the link, wherever they are", async () => {
    const [event] = await reviewEvent()
    const reviewer = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const faraway = await makeUser("rv-cupertino")
    const nowhere = await makeUser("rv-nowhere")
    users.push(faraway, nowhere)
    await db.profiles.create({ data: { id: faraway, name: "Far away", location: "Cupertino", onboarded: true } })
    await db.profiles.create({ data: { id: nowhere, name: "No city", onboarded: true } })

    for (const viewer of [reviewer.id, faraway, nowhere]) {
      expect(await attendeeEventAccess(viewer, event.id, "participate")).toBeNull()
    }
  })

  it("leaves one review event on a second run, its window moved forward on the same row", async () => {
    const [first] = await reviewEvent()
    await new Promise((r) => setTimeout(r, 1_100))
    seed()
    const after = await reviewEvent()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(first.id)
    expect(after[0].start_time.getTime()).toBeGreaterThan(first.start_time.getTime())
  })
})
