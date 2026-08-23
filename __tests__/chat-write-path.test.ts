import { readFileSync } from "fs"
import { join } from "path"

/**
 * Two handlers on one resource, disagreeing about one person and one message.
 *
 * `chat_messages` has two write paths for the same group. They differed on who
 * may write and on whether the message is delivered — so the room's behaviour
 * depended on which screen you were looking at.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const EVENT_CHAT = "app/api/mobile/events/[eventId]/chat/route.ts"

describe("C6 — GET and POST agree about who may write", () => {
  it("resolves entitlement the same way in both handlers", () => {
    /*
     * The GET resolves an entitlement that admits an RSVP or a saved event
     * inside the pre-event window, then reports `write.allowed: true`. The POST
     * hand-rolled `checkIn?.status !== "checked_in"` and answered
     * NOT_CHECKED_IN.
     *
     * So the composer opened for somebody who had RSVP'd, they typed, and the
     * send was refused. Fixing only the write path would leave half the bug —
     * the lie is on the read.
     */
    const src = code(EVENT_CHAT)
    /*
     * Four call sites, two per handler: one for creating the room lazily and
     * one for joining it. The POST diverged on both -- it asked for a check-in
     * to create the room too, so an RSVP'd user who opened the chat and then
     * sent the first message got 404 on the send, for the room they were
     * looking at.
     */
    expect((src.match(/await resolveEntitlement\(eventId, authUser\.userId\)/g) ?? []).length).toBe(4)
    expect((src.match(/entitlementAdmits\(entitlement, window\)/g) ?? []).length).toBe(2)
  })

  it("no longer gates the write on a bare check-in lookup", () => {
    const src = code(EVENT_CHAT)
    expect(src).not.toMatch(/checkIn\?\.status !== "checked_in"/)
  })
})

describe("C5 — a persisted message is a delivered message", () => {
  it("delivers from the event-chat write path", () => {
    /*
     * This handler wrote the row and stopped. No socket emit, no push — so a
     * message sent from the event chat screen was invisible to everyone else
     * until they re-polled, and for anyone with the room already open, never.
     * The sibling endpoint, writing the same table for the same group, has
     * always done both.
     */
    expect(code(EVENT_CHAT)).toMatch(/await deliverToRoom\(\{/)
  })

  it("delivers after moderation, never before", () => {
    /*
     * Emitting first and moderating after creates a window where flagged
     * content is briefly visible to the room. That was a real bug here once.
     */
    const src = code(EVENT_CHAT)
    const moderation = src.indexOf("moderation_status: \"clean\"")
    const delivery = src.indexOf("await deliverToRoom({")
    expect(moderation).toBeGreaterThan(-1)
    expect(delivery).toBeGreaterThan(moderation)
  })

  it("has one implementation of delivery, not two", () => {
    /*
     * Copying the block into the second route would have made two paths that
     * both deliver — better, and still two. The duplication is what let them
     * diverge in the first place.
     */
    const shared = code("lib/room-delivery.ts")
    expect(shared).toMatch(/export async function deliverToRoom/)
    for (const route of [EVENT_CHAT, "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts"]) {
      expect(code(route)).not.toMatch(/emitChatMessage\(/)
    }
  })

  it("never throws, because the message is already committed", () => {
    /*
     * A failed push must not turn a delivered message into a 500 for the
     * sender, and a failed emit must not stop the push.
     */
    const src = code("lib/room-delivery.ts")
    expect((src.match(/catch \(error\) \{/g) ?? []).length).toBe(3)
    expect(src).toMatch(/Promise<void>/)
  })
})
