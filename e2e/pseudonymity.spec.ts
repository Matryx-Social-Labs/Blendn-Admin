import { test, expect, request as playwrightRequest } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { signAccessToken } from "../lib/mobile-auth"

/**
 * E11 - the promise the product is built on.
 *
 * *"You cannot know who I am unless I say so."* Pseudonymity is what makes
 * expressing interest free, which is what makes approaching someone without
 * risking rejection possible. Every other feature is downstream of it.
 *
 * Nine findings in the register were one leak: a route hand-building
 * `{ id, name, image }` without asking whether this viewer may see this
 * subject. They were fixed one at a time. This asserts the *property* rather
 * than any one of them - no room surface may carry another attendee's real
 * name to somebody who has not been shown it.
 *
 * ## The control is the whole test
 *
 * "No real names in the response" passes trivially against a world where
 * nobody has a real name, an empty room, or a 500. So this asserts, in order:
 * the seeded attendees **do** have names, the room **does** contain other
 * people, the surfaces **do** answer, and the viewer's own name **is**
 * serialised by the same stack - and only then that no peer's name appears.
 *
 * Without those, a green result here would mean nothing at all, and it would
 * mean nothing in the most reassuring possible way.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    /*
     * One connection, because a spec file queries sequentially.
     *
     * Tidiness, not a fix, and the distinction is worth keeping. I capped these
     * believing five spec pools of ten, plus the server's twenty, were
     * exhausting Postgres' hundred and hanging CI. Measured: peak connections
     * were **21 with the caps and 21 without** — node-postgres pools lazily and
     * these specs never open more than one. The hypothesis was arithmetic, not
     * evidence.
     *
     * The real cause was the organisation being over its Actions minutes; `e2e`
     * is the longest job and so the only one reclaimed. The cap stays because
     * ten connections for a sequential file is still wrong, not because it
     * changed anything.
     */
    max: 1,
  }),
})

test.afterAll(async () => {
  await db.$disconnect()
})

async function liveRoom() {
  const now = new Date()
  const event = await db.events.findFirst({
    where: {
      deleted_at: null,
      status: "published",
      start_time: { lte: new Date(now.getTime() + 2 * 3_600_000) },
      end_time: { gte: now },
    },
    select: { id: true, title: true },
  })
  if (!event) return null

  const checkIns = await db.event_check_ins.findMany({
    where: { event_id: event.id },
    select: { user_id: true },
  })
  const people = await db.user.findMany({
    where: { id: { in: checkIns.map((c) => c.user_id) } },
    select: { id: true, name: true, email: true },
  })
  return { event, people }
}

test.describe("a room never carries another attendee's real name", () => {
  test("the seeded room has named people in it", async () => {
    const room = await liveRoom()
    expect(
      room,
      "No event is inside its check-in window. `seed-qa.ts` places events relative to " +
        "Date.now(), so its live event ages out after ~3 hours - re-run `npm run seed:qa -- --apply`."
    ).toBeTruthy()

    // The control. Every assertion below is only meaningful because these hold.
    expect(room!.people.length, "the room must have more than one person in it").toBeGreaterThan(1)
    const named = room!.people.filter((p) => p.name && p.name.trim().length > 2)
    expect(
      named.length,
      "the attendees must actually have real names, or 'no real names leaked' is vacuous"
    ).toBeGreaterThan(1)
  })

  test("no room surface leaks one attendee's name to another", async ({ baseURL }) => {
    /*
     * Per-surface timing, kept.
     *
     * It cost nothing and it is the kind of number that is missing exactly
     * when it is wanted — these three routes take ~30ms locally, so a CI log
     * showing seconds would say something real by contrast.
     *
     * The 120s budget that briefly sat here is gone: this spec was suspected
     * of hanging in CI and was not. The job was being reclaimed mid-run
     * because the organisation is over its Actions minutes, and `e2e` is the
     * only job still running by then — the shorter ones finish first and slip
     * through. No test was ever at fault.
     */
    const room = await liveRoom()
    test.skip(!room, "no live event - see the test above")

    const [viewer, ...others] = room!.people
    const named = others.filter((p) => p.name && p.name.trim().length > 2)
    expect(named.length, "need at least one other named attendee").toBeGreaterThan(0)

    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${signAccessToken(viewer.id, viewer.email!)}` },
    })

    /*
     * The three surfaces a checked-in attendee reads about the people around
     * them. Each has leaked in the past: `/chat` through the message author,
     * `/checkins` through the `{ userId, pseudonym }` pair the socket also
     * emitted, and `/matches` through the card.
     */
    const surfaces = [
      `/api/mobile/events/${room!.event.id}/chat`,
      `/api/mobile/events/${room!.event.id}/checkins`,
      `/api/mobile/events/${room!.event.id}/matches`,
    ]

    const leaked: string[] = []
    for (const url of surfaces) {
      const startedAt = Date.now()
      const res = await ctx.get(url)
      // eslint-disable-next-line no-console -- the point is the CI log
      console.log(`  [timing] ${url} -> ${res.status()} in ${Date.now() - startedAt}ms`)
      expect(res.status(), `${url} must answer, or this proves nothing`).toBeLessThan(400)
      const body = await res.text()
      for (const person of named) {
        if (body.includes(person.name!)) leaked.push(`${url} carried "${person.name}"`)
        if (person.email && body.includes(person.email)) {
          leaked.push(`${url} carried "${person.email}"`)
        }
      }
    }

    // Positive control, same context and the same serialisation stack: the
    // viewer's own name *is* returned. Without this, a stack that had stopped
    // emitting names at all would read as a pass.
    const ownProfile = await ctx.get(`/api/mobile/users/${viewer.id}`)
    expect(ownProfile.status()).toBeLessThan(400)
    expect(
      (await ownProfile.text()).includes(viewer.name ?? " "),
      "the viewer's own name must still be served - otherwise the absence above is not a gate"
    ).toBe(true)

    await ctx.dispose()

    expect(
      { leaked, hint: leaked.length ? "A room surface carried a real name to a peer." : "" },
      "pseudonymity is the promise every other feature is downstream of"
    ).toEqual({ leaked: [], hint: "" })
  })

  test("no stored notification carries a real name", async () => {
    /*
     * `notifications` is the copy that outlives the push.
     *
     * A push notification is transient - it shows on a lock screen and is gone.
     * The row written beside it is permanent, sits outside every control that
     * guards `private_messages`, and was originally a verbatim copy of the
     * preview: message text and counterparty names, retained forever. That was
     * the single biggest obstacle to any privacy claim about DMs, encrypted or
     * not.
     *
     * `storedBodyFor` now redacts the content-bearing kinds, so the push says
     * what it needs to and the row says "New message in the room". This asserts
     * the property that redaction exists to produce, rather than asserting that
     * the function was called.
     *
     * `event_checkin` bodies legitimately name somebody - "Cosmic Panda just
     * checked in" - because a pseudonym is what the room is for. Only real
     * names are forbidden.
     */
    const people = await db.user.findMany({
      where: { name: { not: null } },
      select: { name: true },
    })
    const realNames = people.map((p) => p.name!).filter((n) => n.trim().length > 3)
    expect(realNames.length, "the seed must have named accounts, or this is vacuous").toBeGreaterThan(3)

    const stored = await db.notifications.findMany({ select: { kind: true, title: true, body: true } })
    expect(stored.length, "the seed must have notifications, or this is vacuous").toBeGreaterThan(0)

    const leaked = stored
      .filter((n) => realNames.some((name) => n.body.includes(name) || n.title.includes(name)))
      .map((n) => `${n.kind}: ${JSON.stringify(n.body.slice(0, 60))}`)

    expect(
      { leaked, hint: leaked.length ? "A permanent row is holding a real name." : "" },
      "the stored copy outlives the push and sits outside the controls that guard the message"
    ).toEqual({ leaked: [], hint: "" })
  })
})
