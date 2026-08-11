import { readFileSync } from "fs"
import { join } from "path"

/*
 * Identity arrives in one deliberate step, per side.
 *
 * The rules being pinned, and why each would fail quietly:
 *
 * - Seeding. If `likeAtEvent` stops passing pseudonyms, every new conversation
 *   gets nulls, which `displayNameInConversation` reads as "never was
 *   pseudonymous" — so the DM shows real names and nothing errors.
 * - Propagation. Revealing in the room has to carry into DMs from that room, or
 *   two screens disagree about the same person.
 * - Monotonicity. Nothing may set a reveal back to false. A flag cannot unsee a
 *   face, and a control implying otherwise is a lie.
 * - No decline. A refusal path would put rejection back into the one product
 *   built to remove it.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

const REVEAL = "app/api/mobile/conversations/[conversationId]/reveal/route.ts"
const PREFS = "app/api/mobile/events/[eventId]/matches/preferences/route.ts"

describe("a match snapshots what it needs at the moment it happens", () => {
  const src = read("lib/matches.ts")

  it("passes the room pseudonyms into the new conversation", () => {
    /*
     * Snapshotted, not looked up. A DM outlives its event, `origin_event_id`
     * points at `events` rather than `chat_groups`, and the chat lifecycle
     * sweeper deletes old groups — so a join would go null exactly when the
     * history matters most.
     */
    expect(src).toContain("chat_group_members.findMany")
    expect(src).toMatch(/pseudonyms: Object\.fromEntries/)
    expect(src).toContain("eventId,")
  })

  it("seeds reveal from who was already public in that room", () => {
    // Somebody public in the room has nothing left to reveal to a person who
    // saw their card. This is the asymmetric case made honest.
    expect(src).toMatch(/event_match_preferences\.findMany[\s\S]{0,200}revealed: true/)
    expect(src).toMatch(/revealed: revealedRows\.map/)
  })
})

describe("revealing in the room carries into DMs from that room", () => {
  const src = read(PREFS)

  it("updates conversations from this event, on the matching side", () => {
    expect(src).toMatch(/origin_event_id: eventId[\s\S]{0,200}user1_revealed: false/)
    expect(src).toMatch(/origin_event_id: eventId[\s\S]{0,200}user2_revealed: false/)
  })

  it("only ever propagates true, never false", () => {
    /*
     * Monotonic. Un-revealing in the room must not re-anonymise a conversation
     * — the other person has already seen the name and face, and claiming
     * otherwise would be the app lying about what it can do.
     */
    expect(src).toContain("if (revealed === true)")
    expect(src).not.toMatch(/data: \{ user1_revealed: false \}/)
    expect(src).not.toMatch(/data: \{ user2_revealed: false \}/)
  })

  it("skips closed conversations", () => {
    // Nobody to reveal to. Also keeps a closed row from being rewritten by a
    // later room action.
    expect(src).toMatch(/origin_event_id: eventId[\s\S]{0,200}closed_at: null/)
  })
})

describe("the reveal endpoint", () => {
  const src = read(REVEAL)

  it("reveals only the caller's own side", () => {
    // Per side, because revealing is a standing offer rather than a trade:
    // going first must not expose the other person.
    expect(src).toMatch(/isUser1 \? \{ user1_revealed: true \} : \{ user2_revealed: true \}/)
  })

  it("has no path back to false", () => {
    expect(src).not.toMatch(/user1_revealed: false/)
    expect(src).not.toMatch(/user2_revealed: false/)
  })

  it("refuses to reveal without a name and a photo", () => {
    /*
     * Revealing shows exactly those two things. With neither, the switch turns
     * on and the other person's screen is byte-for-byte what it was — so they
     * conclude the feature is broken rather than that the profile is empty.
     *
     * A capability gate for one action, not a completeness meter.
     */
    expect(src).toContain("reveal_incomplete")
    expect(src).toMatch(/Add \$\{missing\} to your profile first/)
    expect(src).toMatch(/"a name and a photo"/)
  })

  it("marks the OTHER side when asking", () => {
    // The flag lives on the person being asked, which is what makes the asker
    // unambiguous without a second column.
    expect(src).toMatch(
      /isUser1 \? \{ user2_reveal_requested: true \} : \{ user1_reveal_requested: true \}/
    )
  })

  it("refuses to ask someone who has already revealed", () => {
    // Enforced at the endpoint, not merely hidden in the UI. Nothing left to
    // ask for.
    expect(src).toContain("They have already revealed")
  })

  it("has no decline path at all", () => {
    /*
     * Deliberately absent, not unimplemented. A decline delivers a rejection,
     * and the whole thesis is "you never approach someone who hasn't already
     * said yes". Someone who does not want to reveal simply does not, and the
     * asker sees "requested" rather than "refused".
     */
    // Comments stripped: the doc block above the handler explains *why* there
    // is no decline, and matching on prose would fail on its own reasoning.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

    expect(code.toLowerCase()).not.toContain("decline")
    expect(code).not.toMatch(/reveal_requested: false/)
    // The request body accepts exactly one optional flag. A `decline` action
    // would have to appear here first.
    expect(src).toMatch(/z\.object\(\{\s*\/\*\*[\s\S]*?\*\/\s*ask: z\.boolean\(\)\.optional\(\),?\s*\}\)/)
  })

  it("refuses on a closed conversation", () => {
    expect(src).toMatch(/if \(conversation\.closed_at\) return notFoundResponse/)
  })

  it("refuses on a conversation that was never pseudonymous", () => {
    // An accepted message request already shows real names; "reveal" there
    // would be a switch that does nothing.
    expect(src).toContain("This conversation already shows real names")
  })
})

describe("every conversation surface gates identity", () => {
  const surfaces = [
    "app/api/mobile/conversations/route.ts",
    "app/api/mobile/conversations/[conversationId]/route.ts",
    "app/api/mobile/conversations/[conversationId]/messages/route.ts",
  ]

  it.each(surfaces)("%s resolves names and photos through the gate", (rel) => {
    const src = read(rel)
    expect(src).toContain("displayNameInConversation")
    expect(src).toContain("mayShowRealName")
  })

  it("the inbox gates the photo, not only the name", () => {
    /*
     * The inbox is the surface where the pseudonym has to hold on its own: it
     * renders before any conversation is opened. A face identifies as surely as
     * a name, so gating one and not the other would be theatre.
     */
    const src = read("app/api/mobile/conversations/route.ts")
    expect(src).toMatch(/image: otherRevealed \? otherUser\.image : null/)
  })
})
