/*
 * The App Review seed (`npm run seed:review`), run as the operator runs it: the script itself, against this database.
 *
 * Launch gate 6 (SCRUM-1196): a reviewer anywhere must have an event to enter, and real users must never see it. The
 * seed used to make its event only when nothing upcoming was published, so on a populated production there was none;
 * it ran 4 h starting 26 h after the run, so the door was open for about 5.5 h of a review that takes days; and it was
 * public. Now there is always exactly one, `review-demo-event`, unlisted, open around the clock for a week from the
 * run, found through the link the script prints. That an unlisted event stays out of the feed and search is
 * discovery-visibility.itest.ts; here, the one reader that shows unlisted events to whoever stands at them.
 */
import { spawnSync } from "child_process"
import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { attendeeEventAccess } from "@/lib/event-door"
import { eventShareUrl } from "@/lib/event-share"
import { signAccessToken } from "@/lib/mobile-auth"
import { pickOccurrence, resolveOccurrence } from "@/lib/occurrences"
import { placesInside } from "@/lib/places-inside"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

const SLUG = "review-demo-event"
const HOUR = 60 * 60 * 1000
const SEED_TIMEOUT = 120_000
/** The script's pin, and a reviewer nowhere near it. */
const PIN = { lat: 12.9721, lng: 77.5938 }
const CUPERTINO = { lat: 37.3349, lng: -122.009 }
const email = `${testId("rv")}@itest.invalid`
const users: string[] = []
const events: string[] = []

/** The script, as `npm run seed:review` runs it, with `email` as the review address unless told otherwise. */
function run(reviewEmail = email) {
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/seed-review-account.ts"], {
    env: { ...process.env, APP_REVIEW_EMAIL: reviewEmail, APP_REVIEW_PASSWORD: "Rooftop-Correct-Horse-26" },
    encoding: "utf8",
    timeout: SEED_TIMEOUT,
  })
  return { ...result, output: `exit ${result.status} ${result.signal ?? ""} ${result.error?.message ?? ""}\n${result.stderr}` }
}

/** A run that must succeed: its stdout, or the test fails with what the script said. */
function seed(): string {
  const result = run()
  if (result.status !== 0) throw new Error(`seed:review failed: ${result.output}`)
  return result.stdout
}

const reviewEvent = () => db.events.findMany({ where: { slug: SLUG } })
const reviewerId = async () => (await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id

async function closedHours(eventId: string): Promise<string[]> {
  const { slots } = await resolveOccurrence(eventId)
  const closed: string[] = []
  for (let at = Date.now(); at <= Date.now() + 7 * 24 * HOUR - 2 * HOUR; at += HOUR) {
    if (!pickOccurrence(slots, new Date(at)).ok) closed.push(new Date(at).toISOString())
  }
  return closed
}

beforeAll(async () => {
  // The suite owns this slug: a database that already has one is not a test database.
  if ((await reviewEvent()).length > 0) throw new Error(`${SLUG} already exists here: run this suite on a throwaway database`)
  // One real upcoming public event: the state of a populated production. Its organiser files the review event.
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
  const all = [...events, ...(await reviewEvent()).map((e) => e.id)]
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: all } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: all } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, all)
  await closeDb()
})

describe("seed:review on a database with real upcoming events", () => {
  let printed: string

  beforeAll(() => {
    printed = seed()
  }, SEED_TIMEOUT)

  it("creates the review event anyway, unlisted, and prints the link the app's Share button makes", async () => {
    const [event] = await reviewEvent()
    expect(event).toMatchObject({ status: "published", visibility: "unlisted", review_demo: true, deleted_at: null })
    expect(printed).toContain(`share link    ${eventShareUrl(event.id)}`)
  })

  it("keeps the door open at every hour of the week from the run", async () => {
    const [event] = await reviewEvent()
    expect(await closedHours(event.id)).toEqual([])
  })

  it("opens by id for the review account and for anybody holding the link, wherever they are", async () => {
    const [event] = await reviewEvent()
    const faraway = await makeUser("rv-cupertino")
    const nowhere = await makeUser("rv-nowhere")
    users.push(faraway, nowhere)
    await db.profiles.create({ data: { id: faraway, name: "Far away", location: "Cupertino", onboarded: true } })
    await db.profiles.create({ data: { id: nowhere, name: "No city", onboarded: true } })

    for (const viewer of [await reviewerId(), faraway, nowhere]) {
      expect(await attendeeEventAccess(viewer, event.id, "participate")).toBeNull()
    }
  })

  it("checks the review account in from Cupertino at the door, with REVIEW_ACCOUNT_IDS naming it", async () => {
    const [event] = await reviewEvent()
    const id = await reviewerId()
    const saved = process.env.REVIEW_ACCOUNT_IDS
    process.env.REVIEW_ACCOUNT_IDS = id
    try {
      const res = await checkinRoute.POST(
        new NextRequest(`http://localhost/api/mobile/events/${event.id}/checkin`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(id, email)}` },
          body: JSON.stringify({ latitude: CUPERTINO.lat, longitude: CUPERTINO.lng, deviceInfo: { gpsAccuracy: 10 } }),
        }),
        { params: Promise.resolve({ eventId: event.id }) }
      )
      expect(res.status).toBe(200)
    } finally {
      process.env.REVIEW_ACCOUNT_IDS = saved
    }
    expect(await db.event_check_ins.count({ where: { event_id: event.id, user_id: id, status: "checked_in" } })).toBe(1)
  })

  it("is not offered to a passer-by standing at its pin", async () => {
    const [event] = await reviewEvent()
    const passerBy = await makeUser("rv-passer")
    users.push(passerBy)
    await db.profiles.create({ data: { id: passerBy, name: "Passer-by", age: 30, onboarded: true } })

    const { places } = await placesInside(passerBy, PIN, 10)
    expect(places.map((p) => p.eventId)).not.toContain(event.id)
  })

  it("on a second run, puts the same row back as it should be and leaves one review event", async () => {
    const [first] = await reviewEvent()
    // Somebody tampered with it between runs; an earlier run's dated event still carries the bypass.
    await db.events.update({ where: { id: first.id }, data: { visibility: "public", status: "cancelled", deleted_at: new Date() } })
    const day = await db.event_occurrences.findFirstOrThrow({ where: { event_id: first.id }, orderBy: { start_time: "desc" } })
    await db.event_occurrences.update({ where: { id: day.id }, data: { cancelled_at: new Date() } })
    const dated = await db.events.create({
      data: {
        slug: `${SLUG}-${testId("old")}`,
        title: "Rooftop Sessions: Live Set",
        description: "an earlier run's event",
        start_time: new Date(Date.now() - 48 * HOUR),
        end_time: new Date(Date.now() - 44 * HOUR),
        timezone: "Asia/Kolkata",
        city: "Bengaluru",
        status: "published",
        visibility: "public",
        organizer_id: first.organizer_id,
        review_demo: true,
      },
    })
    events.push(dated.id)

    seed()

    const after = await reviewEvent()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: first.id, status: "published", visibility: "unlisted", review_demo: true, deleted_at: null })
    expect(after[0].start_time.getTime()).toBeGreaterThan(first.start_time.getTime())
    expect(await closedHours(first.id)).toEqual([])
    expect(await db.events.findUniqueOrThrow({ where: { id: dated.id }, select: { review_demo: true } })).toEqual({ review_demo: false })
  }, SEED_TIMEOUT)

  it("refuses, writing nothing, when the slug is an event it did not make or the address is a staff account's", async () => {
    const [event] = await reviewEvent()
    await db.events.update({ where: { id: event.id }, data: { review_demo: false, visibility: "public" } })
    const taken = run()
    expect(taken.status).toBe(1)
    expect(taken.output).toContain("did not make")
    expect(await db.events.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ review_demo: false, visibility: "public" })

    const staff = await makeUser("rv-staff", "organizer")
    users.push(staff)
    const refused = run(`${staff}@itest.invalid`)
    expect(refused.status).toBe(1)
    expect(refused.output).toContain("organizer account")
    expect(await db.user.findUniqueOrThrow({ where: { id: staff }, select: { password: true } })).toEqual({ password: null })
  }, SEED_TIMEOUT * 2)
})
