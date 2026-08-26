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
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
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
      const res = await ctx.get(url)
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
})
