import { readFileSync } from "fs"
import { join } from "path"

/*
 * Swap names: identity arrives when both sides tap (identity model, owner
 * 2026-11-11), first name and photo, in that chat only.
 *
 * The rules being pinned, and why each would fail quietly:
 *
 * - Seeding. If `likeAtEvent` stops passing pseudonyms, every new conversation
 *   gets nulls, which `displayNameInConversation` reads as "never was
 *   pseudonymous" — so the DM shows real names and nothing errors.
 * - Nobody starts swapped but the two sides of an accepted Lobby ask.
 * - A tap can be taken back only while the other has not tapped.
 * - No decline. A refusal path would put rejection back into the one product
 *   built to remove it.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

const REVEAL = "app/api/mobile/conversations/[conversationId]/reveal/route.ts"
const PREFS = "app/api/mobile/events/[eventId]/matches/preferences/route.ts"

describe("a match snapshots what it needs at the moment it happens", () => {
  const src = read("lib/matches.ts")

  it("passes the room pseudonyms into the new conversation", () => {
    // Snapshotted, not looked up: a DM outlives its event's chat group.
    expect(src).toContain("chat_group_members.findMany")
    expect(src).toMatch(/pseudonyms: Object\.fromEntries/)
    expect(src).toContain("eventId,")
  })

  it("starts nobody swapped, not even somebody named in the room (advisor Q2)", () => {
    const call = src.slice(src.indexOf("const conversation = await openConversation("), src.indexOf("return { conversation, pseudonymRows }"))
    expect(call).not.toMatch(/revealed:/)
    expect(src).not.toMatch(/event_match_preferences\.findMany[\s\S]{0,200}revealed: true/)
  })
})

describe("going public in the room does not name you in the DMs from it", () => {
  it("the room preference no longer writes conversations", () => {
    const src = read(PREFS)
    expect(src).not.toContain("revealConversationsFrom")
    expect(src).not.toMatch(/private_conversations\.update/)
    expect(read("lib/matches.ts")).not.toContain("export async function revealConversationsFrom")
  })
})

describe("a Lobby accept opens already swapped, and only a Lobby accept", () => {
  it("passes both sides as revealed only when the asker and the accepter both saw the copy", () => {
    const src = read("app/api/mobile/board/requests/[requestId]/route.ts")
    expect(src).toMatch(/const swapOnAccept = boardRequest\.names_on_accept && namesOnAccept === true/)
    expect(src).toMatch(/\.\.\.\(swapOnAccept && \{ revealed: \[boardRequest\.from_user_id, boardRequest\.to_user_id\] \}\)/)
    // The ask records the asker's consent only when its client sent it.
    const ask = read("app/api/mobile/events/[eventId]/board/[postId]/requests/route.ts")
    expect(ask).toMatch(/namesOnAccept: z\.literal\(true\)\.optional\(\)/)
    expect(ask).toMatch(/\.\.\.\(namesOnAccept && \{ names_on_accept: true \}\)/)
  })

  it("the message-request, friend and direct openers seed no reveal", () => {
    for (const rel of [
      "app/api/mobile/message-requests/[requestId]/respond/route.ts",
      "app/api/mobile/conversations/route.ts",
      "app/api/mobile/friends/[userId]/conversation/route.ts",
    ]) {
      const src = read(rel)
      const call = src.slice(src.indexOf("openConversation("), src.indexOf("openConversation(") + 200)
      expect(call).not.toMatch(/revealed:/)
    }
  })
})

describe("the swap endpoint", () => {
  const src = read(REVEAL)
  const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function DELETE"))
  const del = src.slice(src.indexOf("export async function DELETE"))

  it("a tap writes only the caller's own side", () => {
    expect(post).toMatch(/isUser1\s*\?\s*await db\.\$queryRaw<Flags\[\]>`UPDATE private_conversations SET user1_revealed = true WHERE id = \$\{conversationId\}::uuid AND user1_revealed = false AND closed_at IS NULL/)
    expect(post).toMatch(/:\s*await db\.\$queryRaw<Flags\[\]>`UPDATE private_conversations SET user2_revealed = true WHERE id = \$\{conversationId\}::uuid AND user2_revealed = false AND closed_at IS NULL/)
    expect(post).not.toMatch(/revealed = false,|revealed: false/)
  })

  it("answers mutual from the re-read after the write, not the read before it", () => {
    expect(post).toMatch(/RETURNING user1_revealed AS u1, user2_revealed AS u2/)
    expect(post).toMatch(/const swapped = after\.user1_revealed && after\.user2_revealed/)
    expect(post).toMatch(/successResponse\(\{ revealed: true, mutual: swapped \}\)/)
  })

  it("refuses to tap without a name and a photo", () => {
    expect(src).toContain("reveal_incomplete")
    expect(src).toMatch(/Add \$\{missing\} to your profile first/)
    expect(src).toMatch(/"a name and a photo"/)
  })

  it("has no separate ask: the tap is the ask, and the body takes nothing", () => {
    // `*_reveal_requested` is only the one-way "already pushed" marker on the asked side: never cleared.
    expect(src).not.toMatch(/reveal_requested: false/)
    expect(src).toMatch(/const revealSchema = z\.object\(\{\}\)\.strict\(\)/)
  })

  it("has no decline path at all", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code.toLowerCase()).not.toContain("decline")
  })

  it("a cancel clears only my own tap, and only while theirs is missing", () => {
    expect(del).toMatch(/where: \{ id: conversationId, closed_at: null, \[mine\]: true, \[theirs\]: false \}/)
    expect(del).toMatch(/data: \{ \[mine\]: false \}/)
    expect(del).toContain('conflictResponse("You have already swapped names")')
  })

  it("refuses on a closed conversation, both ways", () => {
    expect(post).toMatch(/if \(conversation\.closed_at\) return notFoundResponse/)
    expect(del).toMatch(/if \(!conversation \|\| conversation\.closed_at\) return notFoundResponse/)
  })

  it("refuses on a conversation that was never pseudonymous, both ways", () => {
    expect(post).toContain("This conversation already shows real names")
    expect(del).toContain("This conversation already shows real names")
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
