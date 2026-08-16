import { readFileSync } from "fs"
import { join } from "path"
import { cameFromMatch } from "@/lib/conversation-identity"

/**
 * Two things the app could not previously know, and one moderation hole found
 * while giving it the second.
 *
 * 1. Did this conversation come from a mutual like? (`fromMatch`)
 * 2. May I write in this room, and if not, why? (`write`)
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")

describe("fromMatch — the app cannot derive this", () => {
  it("is true when either pseudonym was snapshotted", () => {
    expect(cameFromMatch({ user1_pseudonym: "Cosmic Panda", user2_pseudonym: "Wry Otter" })).toBe(true)
  })

  it("is false for a conversation that never had one", () => {
    /*
     * An accepted message request. It has shown real names since it existed and
     * must never be greeted as a new match.
     */
    expect(cameFromMatch({ user1_pseudonym: null, user2_pseudonym: null })).toBe(false)
  })

  it("is true when only one side has one", () => {
    /*
     * `openConversation` writes both from one snapshot, but a room archived
     * before the match can leave a side null in older rows. One pseudonym is
     * still proof the conversation was born of a match, so `||` not `&&`.
     */
    expect(cameFromMatch({ user1_pseudonym: "Cosmic Panda", user2_pseudonym: null })).toBe(true)
    expect(cameFromMatch({ user1_pseudonym: null, user2_pseudonym: "Wry Otter" })).toBe(true)
  })

  it("cannot be replaced by theyRevealed, which is why it exists", () => {
    /*
     * `mayShowRealName` returns TRUE for both a never-pseudonymous conversation
     * and a revealed match — `if (!pseudonym) return true`. So `theyRevealed`
     * cannot tell them apart, and an opener built on it would greet every
     * accepted message request as a new match.
     */
    const src = read("lib", "conversation-identity.ts")
    const fn = src.slice(src.indexOf("export function mayShowRealName"))
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("if (!pseudonym) return true")
  })

  it("is on the inbox and the thread, so the row and the header agree", () => {
    for (const f of [
      ["app", "api", "mobile", "conversations", "route.ts"],
      ["app", "api", "mobile", "conversations", "[conversationId]", "route.ts"],
    ]) {
      expect(read(...f)).toContain("fromMatch: cameFromMatch(")
    }
  })

  it("ships the boolean, never the pseudonyms", () => {
    // The names stay server-side, where the rest of conversation-identity keeps
    // them. Sending the pseudonym would put a second, ungated name in the
    // payload beside the gated one.
    for (const f of [
      ["app", "api", "mobile", "conversations", "route.ts"],
      ["app", "api", "mobile", "conversations", "[conversationId]", "route.ts"],
    ]) {
      const src = read(...f)
      const body = src.slice(src.indexOf("fromMatch: cameFromMatch("))
      expect(body).not.toContain("user1_pseudonym:")
      expect(body).not.toContain("user2_pseudonym:")
    }
  })
})

describe("the room says whether it takes writes", () => {
  const ROOM = () => read("app", "api", "mobile", "events", "[eventId]", "chat", "route.ts")

  it("reports allowed, the reason, and when the window shuts", () => {
    /*
     * The composer used to guess. Every refusal came back as one
     * `NOT_CHECKED_IN` covering several unrelated situations, so the app showed
     * the wrong reason or let someone type a paragraph and threw it away.
     */
    const src = ROOM()
    const block = src.slice(src.indexOf("write: {"))
    const body = block.slice(0, block.indexOf("},"))
    expect(body).toContain("allowed: denial === null")
    expect(body).toContain("reason: denial?.reason ?? null")
    expect(body).toContain("closesAt: chatClosesAt(")
    expect(body).toContain("eventEndedAt:")
  })

  it("uses the same rule as the write path, not a second copy", () => {
    // The bug this whole area exists to prevent: two gates, drifting.
    expect(ROOM()).toContain("mayWriteToRoom(")
  })

  it("sends no closed-room copy for a mute or a ban", () => {
    // "This chat has closed" would be a lie told to someone who was silenced.
    const src = ROOM()
    const block = src.slice(src.indexOf("write: {"))
    expect(block.slice(0, block.indexOf("},"))).toContain(
      'denial.reason !== "muted" && denial.reason !== "banned"'
    )
  })
})

describe("opening the chat must not un-ban you", () => {
  it("excludes banned and muted from the auto-join", () => {
    /*
     * Found while wiring the write state. The auto-join branched on
     * `status !== "active"` and its `update` set `status: "active"` — so a
     * banned member who was still checked in was restored to good standing by
     * opening the screen. A moderator's decision lasted until the next
     * pull-to-refresh, and it silently defeated the `banned` branch of
     * `mayWriteToRoom`, which by then saw an active row.
     */
    const src = read("app", "api", "mobile", "events", "[eventId]", "chat", "route.ts")
    const guard = src.slice(src.indexOf("const needsJoin ="))
    const body = guard.slice(0, guard.indexOf("if (needsJoin)"))
    expect(body).toContain('membership.status !== "banned"')
    expect(body).toContain('membership.status !== "muted"')
  })

  it("still lets a `left` member rejoin", () => {
    /*
     * `left` means the window closed and the room was archived; the row is kept
     * only because `anonymous_name` lives on it. That is the one status that
     * should come back — excluding it would strip a returning attendee of the
     * pseudonym their old messages are signed with.
     */
    const src = read("app", "api", "mobile", "events", "[eventId]", "chat", "route.ts")
    const guard = src.slice(src.indexOf("const needsJoin ="))
    expect(guard.slice(0, guard.indexOf("if (needsJoin)"))).not.toContain('!== "left"')
  })
})
