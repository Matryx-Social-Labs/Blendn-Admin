import { test, expect, request as playwrightRequest } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { DEFAULT_ACCURACY_POLICY, evaluateCheckIn } from "../lib/geofence"
import { signAccessToken } from "../lib/mobile-auth"
import { MAX_GPS_ACCURACY_METERS } from "../lib/validations/event"

/**
 * E9 — check-in, driven with mocked coordinates.
 *
 * ## Why the API and not a simulator
 *
 * A simulator's mocked location is a coarse instrument: you set a pin and hope
 * the fix that reaches the server is the one you set. This posts the
 * coordinates directly, so the input to `evaluateCheckIn` is exactly the input
 * under test — and it can walk a boundary a metre at a time, which no simulator
 * makes practical. The client's own GPS handling is a separate question and
 * belongs with the client.
 *
 * ## What is asserted
 *
 * GPS check-in is the product's one defensible claim: it is what makes "this
 * person is really here" true, and every organiser number and the whole room
 * gate sit on top of it. Two failure directions, both costly and not
 * symmetric — letting somebody in who is not there voids the claim, and
 * refusing somebody standing inside costs a real attendee their night.
 *
 * The expected verdicts are computed by calling `evaluateCheckIn` itself rather
 * than hard-coded. That is deliberate: hard-coded metres would pin today's
 * radius and buffer, and the seed can change either. What must hold is that the
 * **route agrees with the resolver** — the register's whole diagnosis is one
 * question having several answers, and check-in already had three.
 *
 * ## The seed decays, and that matters here
 *
 * `scripts/seed-qa.ts` places events relative to `Date.now()`, so the event it
 * calls "happening NOW" is only live for its three-hour window. Seed on Monday,
 * test on Wednesday, and this spec has nothing to check into — so it resolves
 * the live event at runtime and says plainly what to do when there is none,
 * rather than failing with something that reads like a product bug.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    /*
     * One connection, because a spec file queries sequentially.
     *
     * Left unset, `@prisma/adapter-pg` takes node-postgres' default of ten.
     * Five spec files each opened a pool that size, alongside the server's
     * twenty, against Postgres' default `max_connections` of 100 — and pools
     * are not released between files. In CI that showed as `mobile-contract`
     * taking 28.8s against 0.5s locally, and then the next spec hanging for
     * the full 45s test timeout waiting for a connection that never freed.
     * The job was reported as cancelled, which is what sent me looking at
     * runner memory and disk for three runs.
     */
    max: 1,
  }),
})

/** Metres → degrees, at Bengaluru's latitude. Good enough to place a fix. */
const METRES_PER_DEG_LAT = 111_320
const offsetNorth = (lat: number, metres: number) => lat + metres / METRES_PER_DEG_LAT

type LiveEvent = {
  id: string
  latitude: number
  longitude: number
  geofence: { type: string; lat: number; lng: number; radius: number; buffer: number }
}

async function liveFencedEvent(): Promise<LiveEvent | null> {
  const now = new Date()
  const rows = await db.events.findMany({
    where: {
      deleted_at: null,
      status: "published",
      start_time: { lte: new Date(now.getTime() + 2 * 3_600_000) },
      end_time: { gte: now },
    },
    select: { id: true, latitude: true, longitude: true, geofence: true },
  })
  // Filtered here rather than in the query: a Prisma Json column needs
  // `Prisma.DbNull` to express "not null", and the row count is small enough
  // that the distinction buys nothing.
  const usable = rows.find((r) => r.latitude !== null && r.longitude !== null && r.geofence)
  if (!usable) return null
  return usable as unknown as LiveEvent
}

async function attendeeToken(email: string) {
  const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true } })
  expect(user, `${email} must be seeded`).toBeTruthy()
  return signAccessToken(user!.id, user!.email!)
}


/**
 * Poll for a refusal row.
 *
 * `recordRefusal` is deliberately fire-and-forget — its docstring says so, and
 * the reasoning is right: the caller is already returning a 400, and turning
 * that into a 500 because a diagnostic write failed would replace a useful
 * refusal with a useless one. So the row lands shortly *after* the response,
 * and reading once races it.
 *
 * Polling is the honest way to assert a deliberately non-blocking write. A
 * fixed sleep would be slower and would still be a race, just a quieter one.
 */
async function refusalFor(eventId: string, reason: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await db.check_in_refusals.findFirst({
      where: { event_id: eventId, reason: reason as never },
      orderBy: { created_at: "desc" },
    })
    if (row || Date.now() > deadline) return row
    await new Promise((r) => setTimeout(r, 100))
  }
}

test.afterAll(async () => {
  await db.$disconnect()
})

test.describe("check-in against a real geofence", () => {
  test("the seed has a live fenced event to check into", async () => {
    const event = await liveFencedEvent()
    expect(
      event,
      "No published, fenced event is inside its check-in window. `seed-qa.ts` places events " +
        "relative to Date.now(), so its 'happening NOW' event ages out after ~3 hours. " +
        "Re-run `npm run seed:qa -- --apply` before this suite."
    ).toBeTruthy()
  })

  test("a fix at the pin is admitted; one well outside is refused and recorded", async ({
    baseURL,
  }) => {
    const event = await liveFencedEvent()
    test.skip(!event, "no live fenced event — see the test above")

    const fence = event!.geofence
    const token = await attendeeToken("ananya.b@blendn.app")
    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })

    // Far enough that no plausible buffer or accuracy allowance reaches it.
    const farLat = offsetNorth(fence.lat, fence.radius + fence.buffer + 400)
    const outside = evaluateCheckIn(
      { lat: farLat, lng: fence.lng },
      fence as never,
      undefined,
      DEFAULT_ACCURACY_POLICY
    )
    expect(outside.ok, "the resolver must consider this point outside, or the test proves nothing")
      .toBe(false)

    const refused = await ctx.post(`/api/mobile/events/${event!.id}/checkin`, {
      data: { latitude: farLat, longitude: fence.lng },
    })
    expect(refused.status(), "a fix outside the fence must not be admitted").toBe(400)

    // Refused, and *recorded* — a wrong pin is invisible until somebody counts
    // the people who stood at the door and could not get in.
    const recorded = await refusalFor(event!.id, "out_of_range")
    expect(recorded, "an out-of-range refusal must be recorded, not just returned").toBeTruthy()
    expect(recorded!.shortfall_metres, "and it must carry how far outside").toBeGreaterThan(0)

    // The admitted case, at the pin itself.
    const inside = evaluateCheckIn({ lat: fence.lat, lng: fence.lng }, fence as never)
    expect(inside.ok, "the pin itself must be inside its own fence").toBe(true)

    const admitted = await ctx.post(`/api/mobile/events/${event!.id}/checkin`, {
      data: { latitude: fence.lat, longitude: fence.lng },
    })
    expect(
      [200, 201].includes(admitted.status()),
      `standing at the pin must be admitted — got ${admitted.status()} ${await admitted.text()}`
    ).toBe(true)

    await ctx.dispose()
  })

  test("a fix too vague to mean anything is refused before the fence is consulted", async ({
    baseURL,
  }) => {
    const event = await liveFencedEvent()
    test.skip(!event, "no live fenced event")

    const token = await attendeeToken("rahul.menon@blendn.app").catch(() =>
      attendeeToken("ananya.b@blendn.app")
    )
    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })

    /*
     * Above the ceiling the fix is not evidence of being anywhere, so it is
     * refused even though the coordinates are the pin itself. That ordering is
     * the point: a device claiming 500m accuracy at the right coordinates is
     * indistinguishable from one guessing, and the old code let poor accuracy
     * *widen* the fence — so claiming to be imprecise bought slack.
     */
    const res = await ctx.post(`/api/mobile/events/${event!.id}/checkin`, {
      data: {
        latitude: event!.geofence.lat,
        longitude: event!.geofence.lng,
        deviceInfo: { gpsAccuracy: MAX_GPS_ACCURACY_METERS + 50 },
      },
    })
    expect(res.status(), "a fix above the accuracy ceiling must be refused").toBe(400)
    expect((await res.json()).error).toMatch(/too weak/i)
    await ctx.dispose()
  })

  test("an event that has not opened refuses, and says which way it is wrong", async ({
    baseURL,
  }) => {
    const future = await db.events.findFirst({
      where: {
        deleted_at: null,
        status: "published",
        start_time: { gt: new Date(Date.now() + 4 * 3_600_000) },
      },
      select: { id: true },
      orderBy: { start_time: "asc" },
    })
    expect(future, "the seed must contain a future event").toBeTruthy()

    const token = await attendeeToken("ananya.b@blendn.app")
    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })
    const res = await ctx.post(`/api/mobile/events/${future!.id}/checkin`, {
      data: { latitude: 12.9716, longitude: 77.5946 },
    })
    expect(res.status(), "checking in before doors must be refused").toBe(400)

    const recorded = await refusalFor(future!.id, "too_early")
    expect(
      recorded,
      "a cluster of too_early is a wrong start time, which is only visible if it is recorded"
    ).toBeTruthy()
    await ctx.dispose()
  })
})
