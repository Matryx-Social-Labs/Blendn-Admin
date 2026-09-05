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

/*
 * Strip comments before slicing. Three times now an assertion has matched its
 * own explanatory prose -- the comment above the code said the same words the
 * test looked for, so it kept passing after the code was gone.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("fromMatch — the app cannot derive this", () => {
  it("is true when either pseudonym was snapshotted", () => {
    expect(cameFromMatch({ user1_pseudonym: "Cosmic Panda", user2_pseudonym: "Wry Otter", origin_board_request_id: null })).toBe(true)
  })

  it("is false for a conversation that never had one", () => {
    /*
     * An accepted message request. It has shown real names since it existed and
     * must never be greeted as a new match.
     */
    expect(cameFromMatch({ user1_pseudonym: null, user2_pseudonym: null, origin_board_request_id: null })).toBe(false)
  })

  it("is true when only one side has one", () => {
    /*
     * `openConversation` writes both from one snapshot, but a room archived
     * before the match can leave a side null in older rows. One pseudonym is
     * still proof the conversation was born of a match, so `||` not `&&`.
     */
    expect(cameFromMatch({ user1_pseudonym: "Cosmic Panda", user2_pseudonym: null, origin_board_request_id: null })).toBe(true)
    expect(cameFromMatch({ user1_pseudonym: null, user2_pseudonym: "Wry Otter", origin_board_request_id: null })).toBe(true)
  })

  it("is false for a board conversation, which is pseudonymous but not a match", () => {
    /*
     * The reason this column exists.
     *
     * A board conversation snapshots pseudonyms exactly like a match does --
     * it has to, because `displayNameInConversation` falls back to the real
     * name without one. So the pseudonym test alone answers `true`, and the
     * client draws the match opener on anything this returns true for. Two
     * people who agreed to share a car would be told they liked each other.
     *
     * Checked before the pseudonyms, because a stored id beats an inference.
     */
    expect(
      cameFromMatch({
        user1_pseudonym: "Cosmic Panda",
        user2_pseudonym: "Wry Otter",
        origin_board_request_id: "3f1c...",
      })
    ).toBe(false)
  })

  it("makes the origin required, so a missed select cannot answer wrongly", () => {
    /*
     * NEGATIVE CONTROL (structural, so it is registered): making the field
     * optional -- `origin_board_request_id?: string | null` -- keeps every
     * caller compiling and silently reintroduces the bug for any caller whose
     * select omits it. That is CLAUDE.md's `venue` trap: a select missing a
     * field reads as the field being absent.
     *
     * Required, the same mistake is a compile error at every call site, which
     * is why this asserts the absence of the `?`.
     */
    const src = codeOnly(read("lib", "conversation-identity.ts"))
    const fn = src.slice(src.indexOf("export function cameFromMatch"))
    const signature = fn.slice(0, fn.indexOf("): boolean"))
    expect(signature).toContain("origin_board_request_id: string | null")
    expect(signature).not.toContain("origin_board_request_id?")
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

describe("a mutual like hands back what the moment needs to paint", () => {
  const MATCHES = () => read("lib", "matches.ts")

  it("returns both pseudonyms, not a second round trip", () => {
    /*
     * The Connection Success sheet draws a generated mark per person, seeded on
     * the pseudonym. Without these the app would have to fetch the conversation
     * before it could paint — a round trip in the one moment in the product that
     * should feel instant.
     *
     * Free: `likeAtEvent` already loads both rows to snapshot them onto the
     * conversation. This returns what it just computed.
     */
    const src = MATCHES()
    expect(src).toContain("pseudonyms?: { you: string; them: string }")
    const ret = src.slice(src.indexOf("return {\n      mutual: true,"))
    expect(ret.slice(0, ret.indexOf("\n    }"))).toContain("byUser.get(likerId)")
  })

  it("sends them only on a mutual, never on a one-sided like", () => {
    /*
     * A one-sided like must reveal nothing about the other person — not even
     * their pseudonym for that event, which is a handle you could watch the room
     * for. The early return carries the bare `mutual: false`.
     */
    const src = MATCHES()
    expect(src).toContain("if (!back) return { mutual: false }")
    const code = codeOnly(src)
    const early = code.slice(
      code.indexOf("if (!back) return"),
      code.indexOf("const [pseudonymRows")
    )
    expect(early).not.toContain("pseudonyms")
  })

  it("falls back rather than sending a real name", () => {
    // If the sweeper archived the group, `anonymous_name` is gone. "Attendee"
    // is the right answer; `user.name` would be a leak dressed as a fallback.
    const src = MATCHES()
    const block = src.slice(src.indexOf("const byUser = new Map"))
    expect(block.slice(0, block.indexOf("\n    }"))).toContain('|| "Attendee"')
  })
})
