import { readFileSync } from "fs"
import { join } from "path"

import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is pure ESM with no CommonJS build and `lib/mobile-auth.ts` imports it
// at module scope for Google OAuth. Jest cannot load it and nothing here needs
// it; `signAccessToken` uses `jsonwebtoken`. Same stub as `checkin.itest.ts`.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * Every message in a room carries its sender's pseudonym — driven through the
 * real handlers.
 *
 * ## Why this exists
 *
 * Both read routes used to load **every** `chat_group_members` row for the
 * group to build the pseudonym map, so the cost grew with the room while the
 * need did not: a 500-person room paid 500 rows to render one page. They now
 * look up only the users appearing on the page.
 *
 * That is a strictly better query and a strictly more dangerous one. If the
 * id set is built wrongly — a sender missed, a quoted author forgotten, a
 * reaction's user dropped — the map returns nothing for them and the response
 * falls back to the literal string `"Attendee"`. That is not a crash and not a
 * type error. It is K3.2: a real person's message rendered as an anonymous one,
 * which reads as a working room.
 *
 * Four structural tests already read these two files as *text* and one of them
 * imports the module, but **nothing executed either route**. So the change that
 * made this optimisation could not have been caught by the suite that was
 * green when it was written.
 *
 * ## The control is the assertion
 *
 * `"Attendee"` is the fallback, so "no real names leaked" passes trivially
 * against a room where the map is empty and everybody is anonymous. Each test
 * therefore asserts the **positive**: this specific member's chosen pseudonym
 * comes back, and it is not the fallback.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupMessagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventChatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    const groups = await db.chat_groups.findMany({
      where: { event_id: { in: events } },
      select: { id: true },
    })
    const groupIds = groups.map((g) => g.id)
    if (groupIds.length) {
      await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
    }
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function member(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

/** A live room with `size` members, each with a distinct pseudonym. */
async function room(size: number) {
  const owner = await makeUser(testId("rp_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rp"),
      title: `Room ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  const group = await db.chat_groups.create({
    data: { event_id: event.id, name: "room", status: "active" },
  })

  const people = []
  for (let i = 0; i < size; i++) {
    const p = await member(`rp_${i}`)
    const pseudonym = `Pseudo ${i} ${testId("x")}`
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: p.id, anonymous_name: pseudonym },
    })
    people.push({ ...p, pseudonym })
  }
  return { eventId: event.id, groupId: group.id, people }
}

const say = (groupId: string, userId: string, content: string) =>
  db.chat_messages.create({ data: { chat_group_id: groupId, user_id: userId, content } })

describe("a room page carries every sender's pseudonym", () => {
  it("names each sender on the group-messages route", async () => {
    const { groupId, people } = await room(4)
    for (const p of people) await say(groupId, p.id, `hello from ${p.pseudonym}`)

    const res = await groupMessagesRoute.GET(
      new NextRequest(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, {
        headers: { authorization: `Bearer ${people[0].token}` },
      }),
      { params: Promise.resolve({ chatGroupId: groupId }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const returned: Array<{ user: { id: string; name: string } }> = body.data.messages

    // The control: the page must actually contain everyone's message, or the
    // name assertion below is checking an empty list.
    expect(returned).toHaveLength(people.length)

    const nameFor = new Map(returned.map((m) => [m.user.id, m.user.name]))
    const wrong = people
      .filter((p) => nameFor.get(p.id) !== p.pseudonym)
      .map((p) => `${p.pseudonym} rendered as ${JSON.stringify(nameFor.get(p.id))}`)

    expect({
      wrong,
      hint: wrong.length
        ? "A member missing from the page-scoped pseudonym lookup falls back to 'Attendee', " +
          "which is K3.2 — a real person's message rendered as an anonymous one."
        : "",
    }).toEqual({ wrong: [], hint: "" })
  })

  it("names a quoted message's author, who need not have spoken on this page", async () => {
    /*
     * The reply path is the one a page-scoped lookup is most likely to miss:
     * the quoted author is reachable only through `parent_message`, so an id
     * set built from senders alone would drop them and render the quote as
     * "Attendee" while the reply above it is named correctly.
     */
    const { groupId, people } = await room(2)
    const [reader, quoted] = people
    const original = await say(groupId, quoted.id, "the original")
    await db.chat_messages.create({
      data: {
        chat_group_id: groupId,
        user_id: reader.id,
        content: "quoting you",
        parent_id: original.id,
      },
    })

    /*
     * `limit=1` is what makes this test test anything, and it was missing.
     *
     * The first version fetched the default page, which contained the quoted
     * author's own message — so their id entered the lookup through the sender
     * path and the assertion held no matter what the reply path did. Deleting
     * the `parent_message` line from the route left it green, which is how the
     * recorded control found it. One message on the page means the quoted
     * author is reachable only through `parent_message`.
     */
    const res = await groupMessagesRoute.GET(
      new NextRequest(
        `http://localhost/api/mobile/chat/groups/${groupId}/messages?limit=1`,
        { headers: { authorization: `Bearer ${reader.token}` } }
      ),
      { params: Promise.resolve({ chatGroupId: groupId }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const reply = body.data.messages.find(
      (m: { parent_message: unknown }) => m.parent_message !== null
    )

    // The control for the isolation: exactly one message, and its sender is
    // the reader — so `quoted` is on the page only as a parent author.
    expect(body.data.messages).toHaveLength(1)
    expect(body.data.messages[0].user.id).toBe(reader.id)

    expect(reply).toBeTruthy()
    expect(reply.parent_message.user.name).toBe(quoted.pseudonym)
  })

  it("names each sender, and each reaction's author, on the event-chat route", async () => {
    const { eventId, groupId, people } = await room(3)
    for (const p of people) await say(groupId, p.id, `hi from ${p.pseudonym}`)

    /*
     * A reaction from somebody with no message on this page.
     *
     * The event-chat route pseudonymises reaction authors as well as senders,
     * so the page-scoped id set has to include them. Without a reactor who is
     * *only* a reactor, that branch is never exercised — the same gap the
     * recorded control found in the quoted-author test, where the author had
     * also spoken and so arrived through the sender path regardless.
     */
    const reactor = await member("rp_react")
    const reactorPseudonym = `Pseudo react ${testId("x")}`
    await db.chat_group_members.create({
      data: { chat_group_id: groupId, user_id: reactor.id, anonymous_name: reactorPseudonym },
    })
    const target = await db.chat_messages.findFirstOrThrow({
      where: { chat_group_id: groupId },
      orderBy: { created_at: "asc" },
      select: { id: true },
    })
    await db.message_reactions.create({
      data: { message_id: target.id, user_id: reactor.id, emoji: "🔥" },
    })

    const res = await eventChatRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/chat`, {
        headers: { authorization: `Bearer ${people[0].token}` },
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const returned: Array<{ user: { id: string; name: string } }> = body.data.messages

    expect(returned.length).toBeGreaterThanOrEqual(people.length)

    const nameFor = new Map(returned.map((m) => [m.user.id, m.user.name]))
    const wrong = people
      .filter((p) => nameFor.get(p.id) !== p.pseudonym)
      .map((p) => `${p.pseudonym} rendered as ${JSON.stringify(nameFor.get(p.id))}`)

    expect({ wrong, hint: "" }).toEqual({ wrong: [], hint: "" })

    const reacted = (
      returned as unknown as Array<{ reactions: Array<{ userId: string; userName: string }> }>
    ).flatMap((m) => m.reactions)

    // The control: the reaction must be on the page at all, or the name check
    // below is reading an empty list.
    expect(reacted.map((r) => r.userId)).toContain(reactor.id)
    expect(reacted.find((r) => r.userId === reactor.id)?.userName).toBe(reactorPseudonym)
  })

  it("does not read the whole roster to render one page", async () => {
    /*
     * Structural, and deliberately so — the honest version of a check I first
     * wrote as a spy.
     *
     * `jest.spyOn(db.chat_group_members, "findMany")` records nothing here:
     * Prisma resolves model delegates through a proxy, so the spy patches an
     * object the route never sees. It reported zero calls against a route that
     * had just made one, which is a guard that would have passed against any
     * implementation at all.
     *
     * Counting rows from outside needs either a module-level proxy around `db`
     * or query-event instrumentation, and both are more machinery than the
     * property warrants. What actually needs preventing is somebody restoring
     * the unscoped lookup, and that is visible in the source: the member query
     * must be filtered by the ids on the page.
     *
     * The three tests above are the behavioural half — they fail if the id set
     * is built wrongly. This one fails if it stops being built at all.
     */
    const routes = [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/events/[eventId]/chat/route.ts",
    ]

    const unscoped: string[] = []
    for (const rel of routes) {
      const src = readFileSync(join(__dirname, "..", "..", rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")

      // Brace-matched rather than a negated character class: four guards in
      // this repo have been vacuous for using `[^}]*` to cross a delimiter.
      const marker = "db.chat_group_members.findMany("
      let from = src.indexOf(marker)
      let found = false
      while (from !== -1) {
        let depth = 0
        for (let i = from + marker.length - 1; i < src.length; i++) {
          if (src[i] === "(") depth++
          else if (src[i] === ")") {
            depth--
            if (depth === 0) {
              found = true
              if (!/user_id\s*:\s*\{\s*in\s*:/.test(src.slice(from, i + 1))) {
                unscoped.push(`${rel}: member lookup is not scoped to the page`)
              }
              break
            }
          }
        }
        from = src.indexOf(marker, from + 1)
      }
      // The control: if the marker stops matching, the loop above checks
      // nothing and reports success.
      expect({ rel, found }).toEqual({ rel, found: true })
    }

    expect({
      unscoped,
      hint: unscoped.length
        ? "The roster lookup must filter on the user ids appearing in the page. Loading every " +
          "member makes the cost grow with the room while the need does not."
        : "",
    }).toEqual({ unscoped: [], hint: "" })
  })
})
