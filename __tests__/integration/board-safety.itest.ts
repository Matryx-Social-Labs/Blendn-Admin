import { NextRequest } from "next/server"

/*
 * The board's safety rules, through the routes, against real rows.
 *
 * Found reviewing the board client (client PR 355): a decline reached the asker
 * three ways — `status: "declined"` and a `decidedAt` in their list, a 409 that
 * said "They have already answered this one", and a withdraw refused with
 * "already been answered". The product rule is that a decline is never
 * delivered. And the board ignored blocks on read, stayed readable after
 * doors, took requests on chat posts, and never spent an offer's seats
 * (SCRUM-514).
 *
 * Mutations observed failing, each reverted:
 * - `asTheAskerSees` returning its input           → "shows the asker a declined ask as pending"
 * - declined moved to the half sorted by stored status → "sorts a declined ask with the pending ones"
 * - `outstandingAsk()` → `liveRequest()` in the cap → "still counts a declined ask toward the cap"
 * - the re-ask check scoped to `status: "declined"` → "refuses a re-ask after a withdrawal..."
 * - `withdraw` claiming `status: "pending"` only   → "lets the asker withdraw a declined ask"
 * - `author_id: { notIn: blocked }` deleted         → both "hides ... blocked" board cases
 * - `from_user_id: { notIn: blocked }` deleted      → "hides an incoming ask from somebody blocked"
 * - the GET doors check deleted                     → "refuses to show the board after doors"
 * - the chat-kind refusal deleted                   → "refuses an ask on a chat post"
 * - `spaces_left: { gt: 0 }` dropped from the seat  → "gives the last seat to exactly one" (500, not 409)
 * - the seat decrement deleted                      → "spends a seat on each accept"
 * - the full-offer refusal on the ask deleted       → "refuses an ask on a full offer"
 * - the cap counting every declined ask, live or not → "lets a declined ask lapse out of the cap"
 * - the waiting half ordered by stored status        → "sorts a declined ask among the pending ones by time"
 * - `asTheAskerSees` applied to incoming too          → "tells the author what they decided"
 * - the seat taken before the block check            → "spends no seat on an accept that is refused"
 * - the seat give-back in the open-failure path cut  → "gives the seat back with the ask"
 * - claim and seat outside one transaction, the claim
 *   loser's seat never given back                     → "spends one seat on a double-tapped accept"
 * - the ask route's doors check deleted              → "refuses posting and asking after doors"
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { ALREADY_ASKED, BOARD_CLOSED } from "@/lib/board"
import { boardWriteDenial } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import * as conversations from "@/lib/conversations"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const requestRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
const myRequests = require("@/app/api/mobile/board/requests/route") as typeof import("@/app/api/mobile/board/requests/route")
const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Person = { id: string; token: string }
interface Row {
  id: string
  status: string
  decidedAt: string | null
  live: boolean
}

const users: string[] = []
const events: string[] = []
const categories: string[] = []
let eventId = ""

afterAll(async () => {
  await db.blocked_users.deleteMany({
    where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] },
  })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await cleanup(users, events)
  await closeDb()
})

/** An event whose doors open tomorrow. */
async function upcoming(): Promise<string> {
  const host = await makeUser(testId("bs-host"), "organizer")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  const start = new Date(Date.now() + 24 * 3600_000)
  await db.events.update({
    where: { id },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) },
  })
  return id
}

/** Going, with a profile complete enough to post and ask. */
async function person(label: string, at: string = eventId): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  const born = new Date()
  born.setFullYear(born.getFullYear() - 30)
  await db.profiles.create({
    data: { id, name: `Test ${label}`, date_of_birth: born, intent_default: ["friendship"] },
  })
  await db.user_interests.createMany({
    data: categories.map((category_id) => ({ user_id: id, category_id })),
  })
  await db.event_rsvps.create({ data: { event_id: at, user_id: id, status: "going" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const req = (method: string, url: string, token: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function offer(author: Person, spaces: number | null, kind: "offer" | "seeking" | "chat" = "offer", at = eventId) {
  const post = await db.board_posts.create({
    data: {
      event_id: at,
      author_id: author.id,
      kind,
      body: `${kind} ${testId("p")}`,
      ...(spaces !== null && { spaces_left: spaces }),
    },
    select: { id: true },
  })
  return post.id
}

const ask = (who: Person, postId: string, at = eventId) =>
  requestRoute.POST(req("POST", `/api/mobile/events/${at}/board/${postId}/requests`, who.token, {}), {
    params: Promise.resolve({ eventId: at, postId }),
  })

const answer = (who: Person, requestId: string, action: "accept" | "decline" | "withdraw") =>
  decide.PATCH(req("PATCH", `/api/mobile/board/requests/${requestId}`, who.token, { action }), {
    params: Promise.resolve({ requestId }),
  })

async function askedId(who: Person, postId: string): Promise<string> {
  const res = await ask(who, postId)
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function list(who: Person): Promise<{ text: string; incoming: Row[]; outgoing: Row[] }> {
  const res = await myRequests.GET(req("GET", "/api/mobile/board/requests", who.token))
  expect(res.status).toBe(200)
  const text = await res.text()
  const { data } = JSON.parse(text) as { data: { incoming: Row[]; outgoing: Row[] } }
  return { text, ...data }
}

async function boardOf(who: Person, at = eventId) {
  const res = await boardRoute.GET(req("GET", `/api/mobile/events/${at}/board`, who.token), {
    params: Promise.resolve({ eventId: at }),
  })
  return res
}

const postTo = (who: Person, at: string) =>
  boardRoute.POST(req("POST", `/api/mobile/events/${at}/board`, who.token, { kind: "chat", body: "anyone else going?" }), {
    params: Promise.resolve({ eventId: at }),
  })

/** Ids alone, for comparing two responses that differ only in which row they name. */
const sansIds = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.split(id).join("<id>"), text)

async function postIdsOn(who: Person): Promise<string[]> {
  const res = await boardOf(who)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { posts: { id: string }[] } }).data.posts.map((p) => p.id)
}

beforeAll(async () => {
  for (const n of [1, 2]) {
    const slug = testId(`bs-cat-${n}`)
    categories.push((await db.categories.create({ data: { name: slug, slug }, select: { id: true } })).id)
  }
  eventId = await upcoming()
})

describe("a decline is never delivered to the asker", () => {
  it("shows the asker a declined ask as pending, with no decision time, still live", async () => {
    const author = await person("dec-author")
    const asker = await person("dec-asker")
    const requestId = await askedId(asker, await offer(author, 2))

    const declined = await answer(author, requestId, "decline")
    expect(declined.status).toBe(200)
    // The author is told what they did. The row really is declined.
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("declined")

    const theirs = await list(asker)
    const row = theirs.outgoing.find((r) => r.id === requestId)
    expect(row).toMatchObject({ status: "pending", decidedAt: null, live: true })
    expect(theirs.text).not.toMatch(/declined/i)
  })

  it("lets it lapse with its event, like any unanswered ask", async () => {
    const at = await upcoming()
    const author = await person("lapse-author", at)
    const asker = await person("lapse-asker", at)
    const post = await offer(author, 1, "offer", at)
    const requestId = ((await (await ask(asker, post, at)).json()) as { data: { id: string } }).data.id
    expect((await answer(author, requestId, "decline")).status).toBe(200)
    await db.events.update({
      where: { id: at },
      data: { start_time: new Date(Date.now() - 2 * 3600_000), end_time: new Date(Date.now() - 3600_000) },
    })

    const row = (await list(asker)).outgoing.find((r) => r.id === requestId)
    expect(row).toMatchObject({ status: "pending", decidedAt: null, live: false })
  })

  it("sorts a declined ask with the pending ones, not after the accepted", async () => {
    /*
     * Ordered on the stored enum, `declined` sits after `accepted`: a row that
     * says pending, sorted among the answered, is the decline delivered by
     * position.
     */
    const author = await person("sort-author")
    const asker = await person("sort-asker")
    const declinedId = await askedId(asker, await offer(author, null, "seeking"))
    expect((await answer(author, declinedId, "decline")).status).toBe(200)
    const acceptedId = await askedId(asker, await offer(author, null, "seeking"))
    expect((await answer(author, acceptedId, "accept")).status).toBe(200)

    const ids = (await list(asker)).outgoing.map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([declinedId, acceptedId]))
    expect(ids.indexOf(declinedId)).toBeLessThan(ids.indexOf(acceptedId))
  })

  it("refuses a re-ask with the same words whether it was declined or is still waiting", async () => {
    const author = await person("reask-author")
    const asker = await person("reask-asker")
    const waitingPost = await offer(author, 2)
    const declinedPost = await offer(author, 2)
    await askedId(asker, waitingPost)
    const declinedId = await askedId(asker, declinedPost)
    expect((await answer(author, declinedId, "decline")).status).toBe(200)

    const again = await ask(asker, waitingPost)
    const afterNo = await ask(asker, declinedPost)
    expect(again.status).toBe(409)
    expect(afterNo.status).toBe(409)
    const [a, b] = [await again.json(), await afterNo.json()]
    expect(b).toEqual(a)
    expect(b.error).toBe(ALREADY_ASKED)
  })

  it("refuses a re-ask after a withdrawal too, so a withdrawn decline reads like a withdrawn ask", async () => {
    const author = await person("wd-author")
    const asker = await person("wd-asker")
    const plainPost = await offer(author, 2)
    const declinedPost = await offer(author, 2)
    const plainId = await askedId(asker, plainPost)
    const declinedId = await askedId(asker, declinedPost)
    expect((await answer(author, declinedId, "decline")).status).toBe(200)
    expect((await answer(asker, plainId, "withdraw")).status).toBe(200)
    expect((await answer(asker, declinedId, "withdraw")).status).toBe(200)

    const [plain, declined] = [await ask(asker, plainPost), await ask(asker, declinedPost)]
    expect([plain.status, declined.status]).toEqual([409, 409])
    expect(await declined.json()).toEqual(await plain.json())
  })

  it("lets the asker withdraw a declined ask, and again, saying nothing", async () => {
    const author = await person("wdd-author")
    const asker = await person("wdd-asker")
    const requestId = await askedId(asker, await offer(author, 2))
    expect((await answer(author, requestId, "decline")).status).toBe(200)

    const first = await answer(asker, requestId, "withdraw")
    const second = await answer(asker, requestId, "withdraw")
    expect([first.status, second.status]).toEqual([200, 200])
    const [one, two] = [await first.text(), await second.text()]
    expect(one).not.toMatch(/declined|answered/i)
    expect(two).toBe(one)

    expect((await db.board_requests.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("withdrawn")
    const row = (await list(asker)).outgoing.find((r) => r.id === requestId)
    expect(row?.status).toBe("withdrawn")
  })

  it("still refuses to withdraw an accepted ask — the asker was told about that one", async () => {
    const author = await person("wda-author")
    const asker = await person("wda-asker")
    const requestId = await askedId(asker, await offer(author, null, "seeking"))
    expect((await answer(author, requestId, "accept")).status).toBe(200)
    expect((await answer(asker, requestId, "withdraw")).status).toBe(409)
  })

  it("still counts a declined ask toward the cap until it lapses", async () => {
    /*
     * If a decline freed a slot, somebody at the cap who could suddenly ask
     * again has been told one of their asks was refused.
     */
    const author = await person("cap-author")
    const asker = await person("cap-asker")
    const ids: string[] = []
    for (let n = 0; n < BOARD.MAX_OUTSTANDING_REQUESTS; n++) {
      ids.push(await askedId(asker, await offer(author, 2)))
    }
    expect(await boardWriteDenial(eventId, asker.id)).toBe("too_many_outstanding")
    expect((await answer(author, ids[0], "decline")).status).toBe(200)
    expect(await boardWriteDenial(eventId, asker.id)).toBe("too_many_outstanding")
  })
})

describe("a decline is never delivered — the edges", () => {
  it("sorts a declined ask among the pending ones by time, not after them", async () => {
    const author = await person("int-author")
    const asker = await person("int-asker")
    const at = (mins: number) => new Date(Date.now() - mins * 60_000)
    const mk = async (status: "pending" | "declined", created: Date) =>
      (
        await db.board_requests.create({
          data: {
            event_id: eventId,
            post_id: await offer(author, null, "seeking"),
            from_user_id: asker.id,
            to_user_id: author.id,
            status,
            created_at: created,
            decided_at: status === "declined" ? new Date() : null,
          },
          select: { id: true },
        })
      ).id
    const oldest = await mk("pending", at(30))
    const middle = await mk("declined", at(20))
    const newest = await mk("pending", at(10))

    const ids = (await list(asker)).outgoing.map((r) => r.id).filter((id) => [oldest, middle, newest].includes(id))
    expect(ids).toEqual([newest, middle, oldest])
  })

  it("lets a declined ask lapse out of the cap with its event, as a pending one does", async () => {
    const other = await upcoming()
    const author = await person("lc-author", other)
    const asker = await person("lc-asker")
    for (let n = 0; n < BOARD.MAX_OUTSTANDING_REQUESTS; n++) {
      await db.board_requests.create({
        data: {
          event_id: other,
          post_id: await offer(author, 2, "offer", other),
          from_user_id: asker.id,
          to_user_id: author.id,
          status: "declined",
          decided_at: new Date(),
        },
      })
    }
    expect(await boardWriteDenial(eventId, asker.id)).toBe("too_many_outstanding")
    await db.events.update({
      where: { id: other },
      data: { start_time: new Date(Date.now() - 2 * 3600_000), end_time: new Date(Date.now() - 3600_000) },
    })
    expect(await boardWriteDenial(eventId, asker.id)).toBeNull()
  })

  it("tells the author what they decided, and changes nobody's count", async () => {
    const author = await person("au-author")
    const asker = await person("au-asker")
    const post = await offer(author, 2)
    const requestId = await askedId(asker, post)
    const countFor = async (who: Person) =>
      ((await (await boardOf(who)).json()) as { data: { posts: { id: string; requestCount: number }[] } }).data.posts.find(
        (p) => p.id === post
      )?.requestCount
    const before = await countFor(asker)

    expect((await answer(author, requestId, "decline")).status).toBe(200)
    const row = (await list(author)).incoming.find((r) => r.id === requestId)
    expect(row?.status).toBe("declined")
    expect(row?.decidedAt).not.toBeNull()
    expect(await countFor(asker)).toBe(before)
  })

  it("withdraws a declined ask with the very response a pending one gets", async () => {
    const author = await person("wsame-author")
    const asker = await person("wsame-asker")
    const pendingId = await askedId(asker, await offer(author, 2))
    const declinedId = await askedId(asker, await offer(author, 2))
    expect((await answer(author, declinedId, "decline")).status).toBe(200)

    const [p, d] = [await answer(asker, pendingId, "withdraw"), await answer(asker, declinedId, "withdraw")]
    expect(p.status).toBe(d.status)
    expect(sansIds(await d.text(), declinedId)).toBe(sansIds(await p.text(), pendingId))
  })

  it("never words a refused re-ask as an answer", async () => {
    expect(ALREADY_ASKED).not.toMatch(/declin|answered|said no|refus/i)
  })

  it("answers a double tap with one ask and the same sentence", async () => {
    const author = await person("dt-author")
    const asker = await person("dt-asker")
    const post = await offer(author, 2)
    const results = await Promise.all([ask(asker, post), ask(asker, post)])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await results.find((r) => r.status === 409)!.json()).error).toBe(ALREADY_ASKED)
    expect(await db.board_requests.count({ where: { post_id: post } })).toBe(1)
  })
})

describe("blocks reach the board, both ways", () => {
  it("hides a post by somebody who blocked you", async () => {
    const author = await person("blk-author")
    const viewer = await person("blk-viewer")
    const post = await offer(author, 2)
    expect(await postIdsOn(viewer)).toContain(post)

    await db.blocked_users.create({ data: { blocker_id: author.id, blocked_id: viewer.id } })
    expect(await postIdsOn(viewer)).not.toContain(post)
  })

  it("hides a post by somebody you blocked", async () => {
    const author = await person("blk2-author")
    const viewer = await person("blk2-viewer")
    const post = await offer(author, 2)
    await db.blocked_users.create({ data: { blocker_id: viewer.id, blocked_id: author.id } })
    expect(await postIdsOn(viewer)).not.toContain(post)
    // ...and the author still sees their own.
    expect(await postIdsOn(author)).toContain(post)
  })

  it("refuses an ask on a blocked person's post exactly as on a post that is gone", async () => {
    const author = await person("blk3-author")
    const asker = await person("blk3-asker")
    const post = await offer(author, 2)
    await db.blocked_users.create({ data: { blocker_id: author.id, blocked_id: asker.id } })

    const blocked = await ask(asker, post)
    const gone = await ask(asker, "00000000-0000-4000-8000-000000000000")
    expect(blocked.status).toBe(gone.status)
    expect(await blocked.json()).toEqual(await gone.json())
    expect(await db.board_requests.count({ where: { post_id: post } })).toBe(0)
  })

  it("hides an incoming ask from somebody blocked", async () => {
    const author = await person("blk4-author")
    const asker = await person("blk4-asker")
    const requestId = await askedId(asker, await offer(author, 2))
    expect((await list(author)).incoming.map((r) => r.id)).toContain(requestId)

    await db.blocked_users.create({ data: { blocker_id: author.id, blocked_id: asker.id } })
    expect((await list(author)).incoming.map((r) => r.id)).not.toContain(requestId)
  })
})

describe("doors and kinds", () => {
  it("refuses to show the board after doors, with the board-closed sentence", async () => {
    const at = await upcoming()
    const viewer = await person("doors-viewer", at)
    expect((await boardOf(viewer, at)).status).toBe(200)

    await db.events.update({ where: { id: at }, data: { start_time: new Date(Date.now() - 60_000) } })
    const res = await boardOf(viewer, at)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe(BOARD_CLOSED)
  })

  it("refuses posting and asking after doors too, in the same words", async () => {
    const at = await upcoming()
    const author = await person("doors2-author", at)
    const asker = await person("doors2-asker", at)
    const post = await offer(author, 2, "offer", at)
    await db.events.update({ where: { id: at }, data: { start_time: new Date(Date.now() - 60_000) } })

    for (const res of [await postTo(author, at), await ask(asker, post, at)]) {
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe(BOARD_CLOSED)
    }
    expect(BOARD_CLOSED).toMatch(/doors open/)
  })

  it("refuses an ask on a chat post, and stores nothing", async () => {
    const author = await person("chat-author")
    const asker = await person("chat-asker")
    const post = await offer(author, null, "chat")
    const res = await ask(asker, post)
    expect(res.status).toBe(422)
    expect(await db.board_requests.count({ where: { post_id: post } })).toBe(0)
  })
})

describe("an offer's seats are spent by accepting (SCRUM-514)", () => {
  it("spends a seat on each accept", async () => {
    const author = await person("seat-author")
    const asker = await person("seat-asker")
    const post = await offer(author, 2)
    const requestId = await askedId(asker, post)
    expect((await answer(author, requestId, "accept")).status).toBe(200)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(1)
  })

  it("gives the last seat to exactly one of two accepts racing for it", async () => {
    const author = await person("race-author")
    const one = await person("race-one")
    const two = await person("race-two")
    const post = await offer(author, 1)
    const first = await askedId(one, post)
    const second = await askedId(two, post)

    const results = await Promise.all([answer(author, first, "accept"), answer(author, second, "accept")])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const refused = results.find((r) => r.status === 409)!
    expect((await refused.json()).error).toBe("That offer is full")

    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(0)
    const statuses = (await db.board_requests.findMany({ where: { post_id: post }, select: { status: true } }))
      .map((r) => r.status)
      .sort()
    // The one who missed out is still waiting, not refused.
    expect(statuses).toEqual(["accepted", "pending"])
  })

  it("refuses an ask on a full offer, and stores nothing", async () => {
    const author = await person("fullask-author")
    const asker = await person("fullask-asker")
    const post = await offer(author, 0)
    const res = await ask(asker, post)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("That offer is full")
    expect(await db.board_requests.count({ where: { post_id: post } })).toBe(0)
  })

  it("refuses an accept on an offer filled since the ask, and leaves the ask pending", async () => {
    const author = await person("full-author")
    const asker = await person("full-asker")
    const post = await offer(author, 1)
    const requestId = await askedId(asker, post)
    await db.board_posts.update({ where: { id: post }, data: { spaces_left: 0 } })
    const res = await answer(author, requestId, "accept")
    expect(res.status).toBe(409)
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("pending")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(0)
  })

  it("spends one seat on a double-tapped accept", async () => {
    const author = await person("dta-author")
    const asker = await person("dta-asker")
    const post = await offer(author, 2)
    const requestId = await askedId(asker, post)
    const results = await Promise.all([answer(author, requestId, "accept"), answer(author, requestId, "accept")])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(1)
  })

  it("spends no seat on an accept that is refused", async () => {
    const author = await person("rs-author")
    const asker = await person("rs-asker")
    const post = await offer(author, 2)
    const requestId = await askedId(asker, post)
    await db.blocked_users.create({ data: { blocker_id: author.id, blocked_id: asker.id } })
    expect((await answer(author, requestId, "accept")).status).toBe(403)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(2)
  })

  it("gives the seat back with the ask when the conversation cannot be opened", async () => {
    const author = await person("gb-author")
    const asker = await person("gb-asker")
    const post = await offer(author, 2)
    const requestId = await askedId(asker, post)
    const spy = jest.spyOn(conversations, "openConversation").mockRejectedValueOnce(new Error("db hiccup"))
    try {
      expect((await answer(author, requestId, "accept")).status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("pending")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBe(2)
  })

  it("leaves an offer that never named its seats alone", async () => {
    const author = await person("nos-author")
    const asker = await person("nos-asker")
    const post = await offer(author, null)
    const requestId = await askedId(asker, post)
    expect((await answer(author, requestId, "accept")).status).toBe(200)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: post } })).spaces_left).toBeNull()
  })
})
