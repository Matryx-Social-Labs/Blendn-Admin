import { readFileSync } from "fs"
import { join } from "path"

/**
 * Six surfaces that answered "may this viewer see this person" themselves.
 *
 * Each one has a module that owns the question and each one skipped it. That is
 * the diagnosis of the whole audit in one file: the architecture is not wrong,
 * it is **optional**. `lib/conversation-identity.ts` was imported at the top of
 * the file that leaked past it.
 *
 * Structural rather than behavioural on purpose. The failure mode is a *new*
 * route hand-building `{ id, name, image }`, and no behavioural test of the six
 * existing routes catches the seventh.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("B1 — opening a conversation does not skip the reveal", () => {
  it("resolves the other person through the conversation gate", () => {
    /*
     * `POST /conversations` returned the row's `{ id, name, image }` straight
     * out, so opening a conversation from a match handed over the real name and
     * face before either side had revealed. The GET six lines above it in the
     * same file has always gated; the module was imported for that one.
     */
    const src = code("app/api/mobile/conversations/route.ts")
    // Two callers now: the list and the open.
    expect((src.match(/displayNameInConversation\(/g) ?? []).length).toBe(2)
    expect((src.match(/mayShowRealName\(/g) ?? []).length).toBe(2)
    // And no raw participant object survives.
    expect(src).not.toMatch(/otherUser: conversationOtherUser\b/)
  })
})

describe("B2 — the interested list is a count, not a directory", () => {
  it("does not select users behind the include flag", () => {
    /*
     * `GET .../interested-users` was cut to a bare count with the argument
     * written out in full: favouriting has no check-in, no pseudonym and no
     * reveal, so nobody who used it consented to being shown, and it is
     * harvestable by topic. `?include=interestedUsers` on the detail route was
     * the same disclosure through a different door.
     */
    const src = code("app/api/mobile/events/[eventId]/route.ts")
    expect(src).not.toMatch(/event_favorites\.findMany/)
    expect(src).toMatch(/interestedUsers: \[\]/)
  })
})

describe("B3 — the socket roster is for people in the room", () => {
  it("keeps names out of the room anyone can join", () => {
    /*
     * `event:{id}` is joinable by any authenticated user for any public event,
     * and `emitEventCheckIn` broadcast `{ real userId, pseudonym }` into it. So
     * anyone could sit in every public room on the platform and harvest the
     * pseudonym-to-account mapping — the cross-event correlation the pseudonyms
     * exist to prevent. The REST twin already answers this with a 403.
     */
    const src = code("lib/socket-server.ts")
    const open = /io\.to\(`event:\$\{eventId\}`\)\.emit\("event:checkin", \{[^}]*\}/.exec(src)
    expect(open).not.toBeNull()
    expect(open![0]).not.toContain("userName")
    expect(open![0]).not.toContain("userImage")

    const roster = /io\.to\(`event:room:\$\{eventId\}`\)\.emit\("event:room:checkin", \{[^}]*\}/.exec(src)
    expect(roster).not.toBeNull()
    expect(roster![0]).toContain("userName")
  })

  it("gates the roster room on a check-in", () => {
    const src = code("lib/socket-auth.ts")
    expect(src).toMatch(/export async function canJoinEventRoom/)
    expect(src).toMatch(/event_check_ins\.findFirst/)
  })
})

describe("G6 — declining does not name the decliner", () => {
  it("sends no name on the decline branch", () => {
    /*
     * Both branches carried the responder's real name, so refusing to cross
     * into real names was the act that published them — to the one person they
     * had just refused, on a lock screen, and permanently into `notifications`.
     */
    const src = code("app/api/mobile/message-requests/[requestId]/respond/route.ts")
    expect(src).toMatch(/"Your message request was declined"/)
    expect(src).not.toMatch(/\$\{responderName\} declined/)
    // Accept still names them: it completes the documented crossing, and a live
    // conversation exists by then anyway. docs/API.md:126.
    expect(src).toMatch(/\$\{responderName\} accepted/)
  })
})

describe("G7 — the blocked list is not a way to keep an identity", () => {
  it("gates the blocked person's name and photo", () => {
    /*
     * `GET /users/:id` 404s for a blocked pair. This returned their real name
     * and photograph to the same caller in the same session.
     */
    const src = code("app/api/mobile/users/blocked/route.ts")
    // Plural: the list asks once for everyone rather than once per person.
    expect(src).toMatch(/maySeeIdentityFor\(/)
    expect(src).not.toMatch(/blocked_user_name: b\.blocked\.name,/)
  })

  it("makes a block override the identity gate in both directions", () => {
    /*
     * Reveal is one-way and non-retractable by design; a block is the one way
     * to un-tell a single person, and the gate did not implement it. Closing a
     * conversation covered pairs who had messaged. It did not cover a mutual
     * like nobody has messaged, or somebody who went public in a shared room —
     * both survive forever.
     */
    const src = code("lib/identity.ts")
    expect(src).toMatch(/blocked_users\s*\n?\s*\.findMany/)
    // Both directions in the predicate, and the override in the fold. The rule
    // itself is asserted behaviourally in `conversation-close.test.ts`; this
    // pins that the override has not been quietly dropped from the source.
    expect(src).toMatch(/blocker_id: viewerId, blocked_id: \{ in: others \}/)
    expect(src).toMatch(/blocked_id: viewerId, blocker_id: \{ in: others \}/)
    expect(src).toMatch(/if \(blocked\.has\(id\) \|\| closed\.has\(id\)\) continue/)
  })
})

describe("G12 — an announcement is the organisation, not a person", () => {
  it("never puts a personal name or an email in the room", () => {
    /*
     * The dashboard route built `session.user.name ?? session.user.email ??
     * "Organiser"` and persisted it into `chat_messages.content` — so an
     * organiser with no display name put their **email address** into a room
     * where every attendee is a pseudonym.
     */
    const dash = code("app/api/events/[id]/announcements/route.ts")
    expect(dash).not.toMatch(/session\.user\.email/)
    expect(dash).toMatch(/broadcastAuthorName\(event\)/)

    const mobile = code("app/api/mobile/events/[eventId]/announce/route.ts")
    expect(mobile).toMatch(/broadcastAuthorName\(event\)/)
    expect(mobile).not.toMatch(/sender\.name \?\? "Organiser"/)
    // And no avatar either: a face identifies as surely as a name.
    expect(mobile).not.toMatch(/userImage: kind === "system" \? undefined : \(sender\.image/)
  })

  it("does not select a relation eventPermissionSelect already claims", () => {
    /*
     * Both fragments get spread into one `select`, and object spread means the
     * second silently wins. A first draft reached through `venue` and quietly
     * replaced the shape `eventPermissions` needs — which is the "a select
     * missing `venue` reads as no venue and denies a venue owner" trap in
     * CLAUDE.md, arriving by a new route.
     */
    const src = code("lib/broadcast-author.ts")
    expect(src).not.toMatch(/venue:/)
  })
})
