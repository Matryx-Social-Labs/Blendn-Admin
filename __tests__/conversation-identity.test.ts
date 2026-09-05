import { readFileSync } from "fs"
import { join } from "path"
import {
  UNNAMED,
  displayNameInConversation,
  mayShowRealName,
  type ConversationIdentity,
} from "@/lib/conversation-identity"

/*
 * The rule the pseudonymous DM rests on.
 *
 * It was about to be true of the message list and false everywhere else: two
 * paths read `profiles.name` directly and knew nothing about revealing, so a
 * typing indicator would have announced the real name on the first keystroke
 * and the push title would have put it on a lock screen. Same shape as the
 * shipped bug commented at `MatchScreen.tsx:513` -- "the anonymity was one tap
 * deep".
 *
 * None of these failures would throw. They would just quietly name somebody.
 */

const A = "aaaa"
const B = "bbbb"

const conv = (over: Partial<ConversationIdentity> = {}): ConversationIdentity => ({
  user1_id: A,
  user2_id: B,
  user1_pseudonym: "Wandering Kestrel",
  user2_pseudonym: "Cosmic Panda",
  user1_revealed: false,
  user2_revealed: false,
  ...over,
})

describe("displayNameInConversation", () => {
  it("uses the pseudonym for a matched pair who have not revealed", () => {
    expect(displayNameInConversation(conv(), A, "Priya Raman")).toBe("Wandering Kestrel")
    expect(displayNameInConversation(conv(), B, "Rahul Mehta")).toBe("Cosmic Panda")
  })

  it("uses the real name once that side reveals", () => {
    const c = conv({ user1_revealed: true })
    expect(displayNameInConversation(c, A, "Priya Raman")).toBe("Priya Raman")
  })

  it("reveals each side independently", () => {
    /*
     * Revealing is a standing offer, not a trade. One side going first must not
     * expose the other -- that is the whole reason the flags are per side
     * rather than a single mutual boolean.
     */
    const c = conv({ user1_revealed: true, user2_revealed: false })
    expect(displayNameInConversation(c, A, "Priya Raman")).toBe("Priya Raman")
    expect(displayNameInConversation(c, B, "Rahul Mehta")).toBe("Cosmic Panda")
  })

  it("uses the real name when the conversation was never pseudonymous", () => {
    /*
     * The case that makes this shippable ahead of the reveal work, and the one
     * that would be catastrophic to get backwards.
     *
     * A null pseudonym means the conversation came from an accepted message
     * request, which has shown real names since it existed. Reading null as
     * "anonymous" would retro-anonymise every conversation in the database --
     * a worse bug than the one this fixes. Today nothing writes pseudonyms, so
     * every conversation takes this branch and nothing visibly changes.
     */
    const c = conv({ user1_pseudonym: null, user2_pseudonym: null })
    expect(displayNameInConversation(c, A, "Priya Raman")).toBe("Priya Raman")
    expect(displayNameInConversation(c, B, "Rahul Mehta")).toBe("Rahul Mehta")
  })

  it("falls back to the pseudonym, not to a stranger, when a revealed user has no name", () => {
    // Someone they have been talking to for a week does not silently become
    // "Someone" because a name is missing.
    const c = conv({ user1_revealed: true })
    expect(displayNameInConversation(c, A, null)).toBe("Wandering Kestrel")
    expect(displayNameInConversation(c, A, "   ")).toBe("Wandering Kestrel")
  })

  it("falls back to a safe label when there is no name and no pseudonym", () => {
    const c = conv({ user1_pseudonym: null })
    expect(displayNameInConversation(c, A, null)).toBe(UNNAMED)
    expect(displayNameInConversation(c, A, "")).toBe(UNNAMED)
  })

  it("refuses to name someone who is not in the conversation", () => {
    // Naming them would be inventing an identity for somebody this
    // conversation has nothing to say about.
    expect(displayNameInConversation(conv(), "stranger", "Priya Raman")).toBe(UNNAMED)
  })

  it("never returns the real name while unrevealed, whatever is passed in", () => {
    /*
     * The property, stated directly. Every caller passes the real name in --
     * that is safe only because this function decides whether it comes back
     * out. If this ever fails, something upstream is leaking.
     */
    const names = ["Priya Raman", "priya@example.com", "P"]
    for (const name of names) {
      expect(displayNameInConversation(conv(), A, name)).not.toContain(name)
    }
  })

  it("trims a name rather than emitting padded whitespace", () => {
    const c = conv({ user1_revealed: true })
    expect(displayNameInConversation(c, A, "  Priya Raman  ")).toBe("Priya Raman")
  })
})

describe("mayShowRealName", () => {
  it("is false for a matched pair who have not revealed", () => {
    expect(mayShowRealName(conv(), A)).toBe(false)
  })

  it("is true once revealed, and true for a never-pseudonymous conversation", () => {
    expect(mayShowRealName(conv({ user1_revealed: true }), A)).toBe(true)
    expect(mayShowRealName(conv({ user1_pseudonym: null }), A)).toBe(true)
  })

  it("is false for a non-participant", () => {
    expect(mayShowRealName(conv(), "stranger")).toBe(false)
  })

  it("agrees with displayNameInConversation on every combination", () => {
    /*
     * Two functions, one rule. They are used at different call sites -- one
     * returns a string, the other decides whether to attach a photo or a
     * profile -- so they must not be able to disagree.
     */
    for (const pseudonym of ["Wandering Kestrel", null]) {
      for (const revealed of [true, false]) {
        const c = conv({ user1_pseudonym: pseudonym, user1_revealed: revealed })
        const shown = displayNameInConversation(c, A, "Priya Raman")
        expect(mayShowRealName(c, A)).toBe(shown === "Priya Raman")
      }
    }
  })
})

describe("no path names a participant without going through the resolver", () => {
  /*
   * A guard, because this exact leak has now been introduced twice by two
   * different people writing two reasonable-looking lines.
   *
   * The rule: any file that puts a participant's name into something the OTHER
   * participant receives must resolve it through `displayNameInConversation`.
   * A grep is crude, but it fails loudly at the moment somebody adds a third
   * path, which is the only time it needs to work.
   */
  const guarded = [
    "lib/socket-server.ts",
    "app/api/mobile/conversations/[conversationId]/messages/route.ts",
  ]

  it.each(guarded)("%s resolves display names through lib/conversation-identity", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
    expect(src).toContain("displayNameInConversation")
  })

  it("the private typing emitter does not send a raw profile name", () => {
    const src = readFileSync(join(process.cwd(), "lib/socket-server.ts"), "utf8")

    // The exact shape of the original bug: `userName` fed straight from the
    // profile row, on every keystroke, to the other participant.
    expect(src).not.toMatch(/userName:\s*profile\?\.name/)
  })

  it("the DM push title does not come straight off the sender row", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/mobile/conversations/[conversationId]/messages/route.ts"),
      "utf8"
    )

    // A lock screen is not an authenticated surface.
    expect(src).not.toMatch(/senderName\s*=\s*message\.sender\.name/)
  })
})

describe("pseudonyms are never derived from identity", () => {
  /*
   * `scripts/seed-room.ts` built `${handle}-${id.slice(-4)}`, which produced
   * "rohan-ohan" for Rohan Bhat — his actual first name inside the thing meant
   * to hide it.
   *
   * The leak in the seed data was the lesser problem. The worse one: a gate
   * that correctly returns the stored pseudonym instead of `profiles.name`
   * looks *identical* to a broken one when the stored pseudonym IS the name.
   * Every anonymity check run against that data was structurally incapable of
   * failing, which is worse than having no check.
   */
  it("the seed uses the same generator as check-in and chat-join", () => {
    const seed = readFileSync(join(process.cwd(), "scripts/seed-room.ts"), "utf8")
    expect(seed).toContain("generateUniqueAnonymousName")
  })

  it("the seed does not build a name from the handle or the person's name", () => {
    const seed = readFileSync(join(process.cwd(), "scripts/seed-room.ts"), "utf8")
    const code = seed.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

    expect(code).not.toMatch(/anonymous_name:\s*`\$\{person\./)
    expect(code).not.toMatch(/anonymous_name:\s*`\$\{[^}]*handle/)
    expect(code).not.toMatch(/anonymous_name:\s*person\./)
  })

  it("a generated pseudonym cannot structurally contain a name", () => {
    // "Adjective Noun" drawn from two fixed word lists — there is no input to
    // leak. The guard is that the generator is used at all.
    const gen = readFileSync(join(process.cwd(), "lib/anonymous-names.ts"), "utf8")
    expect(gen).toMatch(/const ADJECTIVES = \[/)
    expect(gen).toMatch(/const NOUNS = \[/)
    /*
     * It takes a chat group and, optionally, WHO to derive a preference for —
     * never the preferred name as text.
     *
     * This assertion used to pin the single-argument signature. The board needs
     * a person to keep the handle they posted under when they check in, so a
     * second parameter is legitimate; what is not legitimate is it being a
     * string. A free string hands this function's one guarantee — that it can
     * only emit `Adjective Noun` — to every caller, and a caller will
     * eventually pass `profile.name`. That is exactly what the first draft of
     * the board work did, and this test caught it.
     */
    expect(gen).toMatch(/preferFor\?: \{ eventId: string; userId: string \}/)
    expect(gen).not.toMatch(/preferred\?: string/)
  })
})
