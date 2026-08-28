import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * An announcement says what it is, structurally.
 *
 * ## What it used to say instead
 *
 * Nothing. `message_type` has carried `announcement` since the schema was
 * written and **nothing had ever written it** — every announcement was stored
 * as `text`, and the only thing marking it was a `📢 [Announcement from …]`
 * prefix on the content, which any attendee can type into the composer. On
 * reload that prefix is all there was: the client could not style it, the
 * organiser's own feed listed it as an ordinary message, and it was forgeable
 * (K3.1–K3.3).
 *
 * ## Why the enum value is safe to spend on the kind
 *
 * `chat_messages.type` does double duty — it is also the media discriminator,
 * because there are no media columns and the URL lives in `metadata`. So
 * writing a *kind* into it costs the media information.
 *
 * That is fine here and NOT fine for a sponsored send. `broadcastMayCarryMedia`
 * returns true only for `sponsored`, so an announcement is text by rule and
 * nothing is lost. A sponsored image would lose the fact that it is an image,
 * which is why the scheduler is untouched and carries a note saying so.
 *
 * ## The two consequences, one wanted and one not
 *
 * The sentiment sweeper selects `type: "text"`, so announcements now fall out
 * of the room's mood corpus by construction rather than by a new predicate —
 * that is K3.7, and it is asserted here rather than assumed.
 *
 * The conversation list did `type === "text" ? excerpt : "[" + type + "]"`,
 * which would have rendered a perfectly ordinary sentence as the literal string
 * `[announcement]`. A kind marker leaking into copy, caused by a change three
 * files away that looked purely additive. That branch is about media now, and
 * this pins it.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const announceRoute = require("@/app/api/mobile/events/[eventId]/announce/route") as
  typeof import("@/app/api/mobile/events/[eventId]/announce/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupsRoute = require("@/app/api/mobile/chat/groups/route") as
  typeof import("@/app/api/mobile/chat/groups/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    const groups = await db.chat_groups.findMany({
      where: { event_id: { in: events } },
      select: { id: true },
    })
    const ids = groups.map((g) => g.id)
    if (ids.length) {
      await db.chat_messages.deleteMany({ where: { chat_group_id: { in: ids } } })
      await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: ids } } })
      await db.chat_groups.deleteMany({ where: { id: { in: ids } } })
    }
    await db.event_announcements.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (orgs.length) {
    await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
    await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** A live event whose organiser may broadcast into it. */
async function liveRoom() {
  const org = await db.organisations.create({
    data: { display_name: `Ann Org ${testId("o")}` },
  })
  orgs.push(org.id)

  const organiser = await makeUser(testId("ann_own"), "organizer")
  users.push(organiser)
  await db.organisation_members.create({
    data: { org_id: org.id, user_id: organiser, role: "owner" },
  })

  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ann"),
      title: `Announce ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: organiser,
      organizer_org_id: org.id,
    },
  })
  events.push(event.id)

  const group = await db.chat_groups.create({
    data: { event_id: event.id, name: "room", status: "active" },
  })

  const u = await db.user.findUniqueOrThrow({
    where: { id: organiser },
    select: { email: true },
  })
  return { eventId: event.id, groupId: group.id, organiser, token: signAccessToken(organiser, u.email) }
}

const announce = (eventId: string, token: string, content: string) =>
  announceRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    }),
    { params: Promise.resolve({ eventId }) }
  )

describe("an announcement carries its kind", () => {
  it("is stored as `announcement`, not as text", async () => {
    const room = await liveRoom()

    const res = await announce(room.eventId, room.token, "Doors close at eleven")
    expect(res.status).toBeLessThan(400)

    const rows = await db.chat_messages.findMany({
      where: { chat_group_id: room.groupId },
      select: { type: true, content: true },
    })

    // The control: the announcement must have reached the room at all, or the
    // type assertion is describing an empty set.
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain("Doors close at eleven")
    expect(rows[0].type).toBe("announcement")
  })

  it("stays out of the room's mood corpus", async () => {
    /*
     * K3.7. Asserted through the sweeper's own predicate rather than by calling
     * it, so this is about the rows the sweeper can see rather than about what
     * it happens to do with them.
     */
    const room = await liveRoom()
    await announce(room.eventId, room.token, "The bar is closing in ten minutes")

    // A real attendee message, so the predicate is proven to match something.
    const attendee = await makeUser(testId("ann_att"))
    users.push(attendee)
    await db.chat_messages.create({
      data: { chat_group_id: room.groupId, user_id: attendee, content: "great night" },
    })

    const corpus = await db.chat_messages.findMany({
      where: { chat_group_id: room.groupId, type: "text", deleted_at: null },
      select: { content: true },
    })

    expect(corpus).toHaveLength(1)
    expect(corpus[0].content).toBe("great night")
  })

  it("still previews as its text in the conversation list", async () => {
    /*
     * The regression the kind change would have caused. The list rendered
     * anything that was not `text` as `[<type>]`, so this sentence would have
     * appeared to the attendee as the literal string `[announcement]`.
     */
    const room = await liveRoom()
    const attendee = await makeUser(testId("ann_reader"))
    users.push(attendee)
    await db.chat_group_members.create({
      data: { chat_group_id: room.groupId, user_id: attendee, anonymous_name: "Reader" },
    })
    await announce(room.eventId, room.token, "Last orders at half past")

    const u = await db.user.findUniqueOrThrow({ where: { id: attendee }, select: { email: true } })
    const res = await groupsRoute.GET(
      new NextRequest("http://localhost/api/mobile/chat/groups", {
        headers: { authorization: `Bearer ${signAccessToken(attendee, u.email)}` },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const rows = Array.isArray(body.data) ? body.data : (body.data.groups ?? [])
    const mine = rows.find((g: { id: string }) => g.id === room.groupId)

    expect(mine).toBeTruthy()
    expect({
      preview: mine.lastMessage?.content,
      hint: "",
    }).toEqual({ preview: expect.stringContaining("Last orders at half past"), hint: "" })
  })
})
