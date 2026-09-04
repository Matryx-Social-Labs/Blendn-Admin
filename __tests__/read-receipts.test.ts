import { readFileSync } from "fs"
import { join } from "path"

import { isReadForViewer } from "@/lib/read-receipts"

/**
 * A privacy switch that does nothing is worse than no switch.
 *
 * `profiles.read_receipts` was written by the settings screen and read by
 * nothing — a round trip to itself. Somebody who turned it off behaved as
 * though they had, and the ✓✓ kept arriving.
 *
 * There were two defects in one function. `emitPrivateRead` relayed
 * `private:read` and **wrote nothing**, so the sender's ✓✓ was a live
 * broadcast that reverted to ✓ on reload — the only writer of `is_read` was a
 * side effect of the messages GET, a different trigger entirely. And it
 * relayed regardless of the reader's setting.
 *
 * The rule is shared because the fact leaks on two surfaces: the socket, and
 * `lastMessage.isRead` in the conversation list, which IS a read receipt
 * whenever the last message is the caller's own. Fixing only the socket would
 * have moved the disclosure one screen sideways — which is how the reaction
 * payload survived being fixed twice.
 */
const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("isReadForViewer", () => {
  it("tells you about your own reading, always", () => {
    // Somebody else sent it; `isRead` is the viewer's own state and discloses
    // nothing about anyone else.
    expect(
      isReadForViewer({ senderIsViewer: false, isRead: true, otherPartyAllowsReceipts: false })
    ).toBe(true)
    expect(
      isReadForViewer({ senderIsViewer: false, isRead: false, otherPartyAllowsReceipts: false })
    ).toBe(false)
  })

  it("withholds the other person's reading when they have it off", () => {
    expect(
      isReadForViewer({ senderIsViewer: true, isRead: true, otherPartyAllowsReceipts: false })
    ).toBe(false)
  })

  it("reports it when they allow it", () => {
    expect(
      isReadForViewer({ senderIsViewer: true, isRead: true, otherPartyAllowsReceipts: true })
    ).toBe(true)
  })

  it("defaults to on when the setting has never been touched", () => {
    /*
     * The column is nullable and most rows predate the setting. Defaulting to
     * silence would switch read receipts off for every account that never
     * opened settings — a behaviour change nobody asked for, delivered as a
     * privacy improvement.
     */
    expect(
      isReadForViewer({ senderIsViewer: true, isRead: true, otherPartyAllowsReceipts: null })
    ).toBe(true)
    expect(
      isReadForViewer({ senderIsViewer: true, isRead: true, otherPartyAllowsReceipts: undefined })
    ).toBe(true)
  })
})

describe("both surfaces honour it, and reading is still recorded", () => {
  it("finds the two call sites at all", () => {
    // The control: a renamed file makes every assertion below vacuous.
    expect(code("lib/socket-server.ts")).toContain("emitPrivateRead")
    expect(code("app/api/mobile/conversations/route.ts")).toContain("lastMessage")
  })

  it("persists the read before deciding whether to announce it", () => {
    /*
     * The order is the point. Suppressing the write as well would leave
     * somebody with read receipts off staring at an unread badge that never
     * cleared — a settings toggle silently breaking an unrelated feature.
     */
    const src = code("lib/socket-server.ts")
    const fn = src.slice(src.indexOf("export async function emitPrivateRead"))
    const body = fn.slice(0, fn.indexOf("\n}"))

    const write = body.indexOf("private_messages.updateMany")
    const gate = body.indexOf("read_receipts")
    const emit = body.indexOf('emit("private:read"')

    expect(write).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(write)
    expect(emit).toBeGreaterThan(gate)
  })

  it("only marks messages the reader did not send", () => {
    // Otherwise somebody can mark their OWN messages read and manufacture a
    // receipt on the other side.
    const src = code("lib/socket-server.ts")
    const fn = src.slice(src.indexOf("export async function emitPrivateRead"))
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/sender_id:\s*\{\s*not:/)
  })

  it("does not report the sender's own receipt in the conversation list", () => {
    const src = code("app/api/mobile/conversations/route.ts")
    expect(src).toMatch(/isRead:\s*isReadForViewer\(/)

    /*
     * Pins the PRODUCER, not the absence of the old shape. A negative match on
     * `isRead: lastMessage.is_read` cannot work here: that expression is the
     * legitimate argument being passed INTO the helper, so the guard would
     * fail on the fix. What matters is that the decision is fed the OTHER
     * party's setting — passing the viewer's own would compile, read
     * plausibly, and honour nothing.
     */
    expect(src).toMatch(/otherPartyAllowsReceipts:\s*otherUser\.profile\?\.read_receipts/)
    expect(src).toMatch(/senderIsViewer:\s*lastMessage\.sender_id === authUser\.userId/)
  })
})
