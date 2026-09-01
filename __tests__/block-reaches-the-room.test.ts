import { readFileSync } from "fs"
import { join } from "path"

/*
 * Block was a DM-and-profile feature only.
 *
 * `blocked_users` was consulted nowhere in group chat: not when listing
 * history, not when broadcasting over the socket, not when sending push. So
 * blocking somebody removed your ability to message them and nothing else —
 * walk into their event room and their messages arrived in the history, live
 * over the socket, and on your lock screen. In a pseudonymous room you could
 * not even tell which "Cosmic Panda" they were.
 *
 * `notifyEventCheckIn` would additionally tell you that a person you had
 * blocked had just walked in.
 *
 * These are source assertions rather than behavioural ones because the paths
 * they guard are a Prisma `where` clause, a socket fan-out and a push
 * fan-out — three places a future change could quietly drop the filter, none
 * of which fail loudly when it happens. `blockCounterparties` itself is
 * covered behaviourally below.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

describe("every group-chat surface consults blocked_users", () => {
  const surfaces = [
    "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
    "app/api/mobile/events/[eventId]/chat/route.ts",
  ]

  it.each(surfaces)("%s filters history on the block list", (rel) => {
    const src = read(rel)
    expect(src).toContain("blockCounterparties")
    expect(src).toMatch(/notIn: blockedIds/)
  })

  it("the live socket excludes blocked recipients server-side", () => {
    /*
     * Server-side, not client-side, and the distinction is the decision.
     *
     * The block list is already on the device, so the client COULD drop the
     * message — but then the platform has still delivered it, and any client
     * bug re-exposes it. A block is a safety promise, not a mute.
     *
     * This used to assert against the route file. Delivery moved into
     * `lib/room-delivery.ts`, because the event-chat POST wrote to the same
     * table and delivered nothing at all — so the filter now lives in one place
     * and the next test asserts both routes reach it. That is a stronger
     * guarantee than the one this replaced: a third write path can no longer be
     * added without either using it or failing the check below.
     */
    const src = read("lib/room-delivery.ts")
    expect(src).toMatch(/emitChatMessage\(\s*\n?\s*chatGroupId,[\s\S]{0,600}senderBlocked\s*\n?\s*\)/)
  })

  it("every chat write path delivers through the one place that filters", () => {
    /*
     * `POST /events/:id/chat` persisted a message and stopped — no emit, no
     * push — so blocks were irrelevant there because nothing was delivered at
     * all. Fixing the delivery without sharing the filter would have created a
     * second unfiltered fan-out.
     */
    for (const route of [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/events/[eventId]/chat/route.ts",
    ]) {
      const src = read(route)
      expect(src).toMatch(/await deliverToRoom\(\{/)
      // And does not hand-roll its own fan-out beside it.
      expect(src).not.toMatch(/notifyGroupMessage\(/)
    }
  })

  it("emitChatMessage excludes by user room, so it crosses instances", () => {
    // `except()` on `user:${id}` goes through the Redis adapter; filtering by
    // socket id would only reach sockets on the instance handling the request.
    const src = read("lib/socket-server.ts")
    expect(src).toMatch(/except\(excludeUserIds\.map\(\(id\) => `user:\$\{id\}`\)\)/)
  })

  it("the group push fan-out drops blocked recipients", () => {
    // The loudest surface in the product.
    const src = read("lib/room-delivery.ts")
    expect(src).toMatch(/user_id: \{ notIn: senderBlocked \}/)
  })

  it("skips delivery entirely if it cannot tell who blocked whom", () => {
    /*
     * Fails closed on delivery. If `blockCounterparties` throws, pushing to
     * everyone would put a blocked person's message on somebody's lock screen —
     * the exact harm the filter exists for. A skipped delivery costs a message
     * that appears on the next poll.
     */
    const src = read("lib/room-delivery.ts")
    expect(src).toMatch(/Room delivery skipped: could not resolve blocks[\s\S]{0,120}return/)
  })

  it("the check-in ping does not announce someone you blocked", () => {
    const src = read("app/api/mobile/events/[eventId]/checkin/route.ts")
    expect(src).toContain("blockCounterparties")
  })
})

describe("blocking closes the conversation and cancels both request directions", () => {
  const src = read("app/api/mobile/users/[userId]/block/route.ts")

  it("closes the conversation rather than leaving it readable", () => {
    // Blocking left the thread sitting in both inboxes with its full history.
    // "Block" that leaves the conversation open is not what anyone means.
    expect(src).toContain("closeConversation")
    expect(src).toContain('"block"')
  })

  it("evicts both sides from the conversation socket room", () => {
    expect(src).toContain("closeConversationRoom")
  })

  it("cancels pending requests in BOTH directions", () => {
    /*
     * It cancelled only inbound ones, and the accept handler never re-checked —
     * so A could request B, block B, and B could then accept, creating a
     * conversation between two blocked people. Once that row exists,
     * `mayConverse` returns true for them forever.
     */
    expect(src).toMatch(/sender_id: targetId, recipient_id: authUser\.userId/)
    expect(src).toMatch(/sender_id: authUser\.userId, recipient_id: targetId/)
  })

  it("the accept handler re-checks the block at accept time", () => {
    // A request can sit pending for days; either party may have blocked the
    // other in between.
    const respond = read("app/api/mobile/message-requests/[requestId]/respond/route.ts")
    expect(respond).toMatch(/blockedEitherWay\(messageRequest\.sender_id, authUser\.userId\)/)
  })
})

describe("blockCounterparties", () => {
  const findMany = jest.fn()

  beforeEach(() => {
    jest.resetModules()
    findMany.mockReset()
  })

  async function load() {
    jest.doMock("@/lib/db", () => ({ db: { blocked_users: { findMany } } }))
    return (await import("@/lib/conversations")).blockCounterparties
  }

  it("returns the other person, whichever direction the block was filed", async () => {
    // The row is directional; the effect is symmetric. Neither person should
    // see the other, whoever pressed the button.
    findMany.mockResolvedValue([
      { blocker_id: "me", blocked_id: "they-blocked-by-me" },
      { blocker_id: "they-blocked-me", blocked_id: "me" },
    ])

    const blockCounterparties = await load()
    const ids = await blockCounterparties("me")

    expect(ids.sort()).toEqual(["they-blocked-by-me", "they-blocked-me"])
    expect(ids).not.toContain("me")
  })

  it("de-duplicates a mutual block", async () => {
    // Both blocked each other. One id out, not two — otherwise the `notIn`
    // clause and the socket `except()` list carry a pointless duplicate.
    findMany.mockResolvedValue([
      { blocker_id: "me", blocked_id: "them" },
      { blocker_id: "them", blocked_id: "me" },
    ])

    const blockCounterparties = await load()
    expect(await blockCounterparties("me")).toEqual(["them"])
  })

  it("returns an empty list when nobody is blocked", async () => {
    // The common case, and the one that must stay cheap: callers skip the
    // filter entirely rather than emitting `notIn: []`.
    findMany.mockResolvedValue([])

    const blockCounterparties = await load()
    expect(await blockCounterparties("me")).toEqual([])
  })
})
