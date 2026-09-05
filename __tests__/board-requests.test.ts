import { readFileSync } from "fs"
import { join } from "path"

import { preferredPseudonymFor } from "@/lib/anonymous-names"

/**
 * The board's request half: who may ask, what accepting produces, and the two
 * things that are silent when they break.
 *
 * The gates themselves are pure and tested in `board-gates.test.ts`; the
 * database's invariants are in `board.itest.ts` against real Postgres. What is
 * left — and what is asserted here — is the wiring that no type can hold:
 * whether the accept path actually hands `openConversation` the two pieces of
 * context that make a board conversation safe to render.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")

/*
 * Strip comments before slicing. Three times in this project an assertion has
 * matched its own explanatory prose — the comment above the code said the same
 * words the test looked for, so it kept passing after the code was gone.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const DECIDE = ["app", "api", "mobile", "board", "requests", "[requestId]", "route.ts"]
const SEND = [
  "app", "api", "mobile", "events", "[eventId]", "board", "[postId]", "requests", "route.ts",
]

describe("a handle that exists before the room does", () => {
  it("is stable for one person at one event", () => {
    /*
     * The board is read over days. A name that changed between two reads would
     * make the person who offered a seat yesterday a stranger today.
     */
    const a = preferredPseudonymFor("event-1", "user-1")
    expect(preferredPseudonymFor("event-1", "user-1")).toBe(a)
  })

  it("is different at the next event, which is the whole point", () => {
    /*
     * One handle across events is the cross-event correlation the pseudonyms
     * exist to prevent — `pseudonymAvatar.ts` states it in as many words about
     * seeding on a user id, and the same argument applies to the name.
     */
    expect(preferredPseudonymFor("event-1", "user-1")).not.toBe(
      preferredPseudonymFor("event-2", "user-1")
    )
  })

  it("differs between two people at one event", () => {
    /*
     * A board where everybody renders identically is the state this replaced:
     * the room handle is minted at check-in, and the board is what happens
     * before check-in, so every post fell back to the literal "Attendee".
     */
    const names = new Set(
      ["u1", "u2", "u3", "u4", "u5", "u6"].map((u) => preferredPseudonymFor("event-1", u))
    )
    expect(names.size).toBeGreaterThan(1)
    expect(names.has("Attendee")).toBe(false)
  })

  it("is a preference at check-in, not an override", () => {
    /*
     * Uniqueness is enforced per chat group and must stay that way — 6,480
     * combinations means a 200-person room collides with near certainty, and
     * the write has no `P2002` catch. So the board handle is used only when it
     * is free, and the existing fallback runs when it is not.
     */
    const src = codeOnly(read("lib", "anonymous-names.ts"))
    const fn = src.slice(src.indexOf("export async function generateUniqueAnonymousName"))
    expect(fn).toContain("const preferred = preferredPseudonymFor(preferFor.eventId, preferFor.userId)")
    expect(fn).toContain("if (!existingNames.has(preferred)) return preferred")
  })

  it("is what check-in asks for, so the board name survives the doors", () => {
    /*
     * Without this the room renames somebody on arrival, and the person they
     * arranged to travel with cannot find them. The board route's own comment
     * has promised this continuity since it was written; until this line it
     * described behaviour the code did not have.
     */
    const src = codeOnly(read("app", "api", "mobile", "events", "[eventId]", "checkin", "route.ts"))
    expect(src).toContain("{ eventId, userId: authUser.userId }")
  })
})

describe("you cannot ask somebody who has not posted", () => {
  it("takes the recipient from the post, never from the request body", () => {
    /*
     * The rule is structural rather than a check: `board_requests.post_id` is
     * required and `to_user_id` is read off the post, so there is no path that
     * forgets it. This asserts the absence of the thing that would undo it —
     * a recipient in the payload — because that is what a later "let me ask
     * anyone" feature would add, and it would arrive looking harmless.
     */
    const src = codeOnly(read(...SEND))
    /*
     * Sliced to the handler, not to the `// POST` comment above it: `codeOnly`
     * has already removed that, `indexOf` returns -1, and `slice(n, -1)` then
     * hands back almost the whole file — which contains `to_user_id` further
     * down and passed for the wrong reason. Caught by running it.
     */
    const schema = src.slice(
      src.indexOf("const requestSchema"),
      src.indexOf("export async function POST")
    )
    expect(schema).not.toMatch(/recipientId|toUserId|to_user_id/)
    expect(src).toContain("to_user_id: post.author_id")
  })

  it("refuses a request against a deleted post, in the query", () => {
    // Soft deletion is only a deletion if every read honours it.
    const src = codeOnly(read(...SEND))
    const lookup = src.slice(src.indexOf("db.board_posts.findFirst"))
    expect(lookup.slice(0, lookup.indexOf("})"))).toContain("deleted_at: null")
  })

  it("consults blocks in both directions", () => {
    /*
     * The half that gets missed is the reverse one: somebody you blocked must
     * not be able to reach you either. `blockCounterparties` is both.
     */
    expect(codeOnly(read(...SEND))).toContain("blockCounterparties")
  })
})

describe("accepting opens a conversation that can be told apart from a match", () => {
  it("passes the board request as the conversation's origin", () => {
    /*
     * THE guard on this PR. Drop `boardRequestId` and `cameFromMatch` falls
     * through to its pseudonym test — which is true for a board conversation,
     * because a board conversation has to be pseudonymous — so the client
     * draws the match opener on two people who agreed to share a car.
     *
     * Nothing else catches it: the argument is optional on `openConversation`
     * (two of its three callers have no board request), so removing it
     * typechecks, and every behavioural assertion about the conversation still
     * passes because the conversation is still correctly created.
     */
    const src = codeOnly(read(...DECIDE))
    const call = src.slice(src.indexOf("openConversation("))
    const args = call.slice(0, call.indexOf("\n    )"))
    expect(args).toContain("boardRequestId: requestId")
  })

  it("passes pseudonyms, because the fallback is the real name", () => {
    /*
     * `displayNameInConversation` returns the real name when there is no
     * pseudonym. So a board conversation opened without them hands over both
     * real names at the moment of acceptance.
     */
    const src = codeOnly(read(...DECIDE))
    const call = src.slice(src.indexOf("openConversation("))
    expect(call.slice(0, call.indexOf("\n    )"))).toContain("pseudonyms")
    expect(src).toContain("boardPseudonyms(boardRequest.event_id")
  })

  it("claims the request with the status in the predicate", () => {
    /*
     * The read above the claim is not a lock, so two taps — or a decline racing
     * a withdraw — both pass it. `updateMany` with `status: "pending"` in the
     * where clause means exactly one writes and the loser is told the truth
     * rather than silently overwriting the first answer.
     */
    const src = codeOnly(read(...DECIDE))
    const claims = src.match(/db\.board_requests\.updateMany\(\{[\s\S]*?\}\)/g) ?? []
    // Two claims (the decline/withdraw path and the accept path) plus the revert.
    expect(claims.length).toBeGreaterThanOrEqual(3)
    expect(claims.filter((c) => c.includes('status: "pending"')).length).toBeGreaterThanOrEqual(2)
  })

  it("puts the request back if the conversation cannot be opened", () => {
    /*
     * Unmatching is permanent, so `openConversation` throws on a closed pair.
     * Claiming first and discovering it second would leave the request marked
     * accepted with no conversation behind it — a state nothing retries and no
     * screen can explain, and the asker's cap consumed for ever.
     */
    const src = codeOnly(read(...DECIDE))
    const handler = src.slice(src.indexOf("} catch (error) {", src.indexOf("openConversation(")))
    expect(handler).toContain('status: "pending"')
    expect(handler).toContain("decided_at: null")
  })

  it("lets a decision happen after doors, so a cap is never stuck", () => {
    /*
     * The board closes at doors; answering it does not. A pending request holds
     * a slot in the asker's outstanding cap, so refusing decisions after doors
     * would leave one unanswered ask costing a fifth of every future board, for
     * ever. Asserted as the absence of the check that would do it.
     */
    const src = codeOnly(read(...DECIDE))
    expect(src).not.toContain("start_time")
  })
})

describe("the push says that something happened, not what", () => {
  it("carries neither the pseudonym nor the message", () => {
    /*
     * A board request is the one message in this product sent to somebody who
     * has not agreed to hear from the sender at all, and all of it renders on a
     * lock screen other people can see. The match copy was stripped of even a
     * pseudonym for exactly this reason; DM and group pushes were not, and that
     * is a live finding rather than a precedent to follow.
     */
    const src = codeOnly(read("lib", "push-notifications.ts"))
    for (const helper of ["notifyBoardRequest(", "notifyBoardRequestAccepted("]) {
      const fn = src.slice(src.indexOf(`export async function ${helper}`))
      /*
       * The two lines a person actually reads. Scoped to them rather than the
       * whole function because `channelId: "messages"` matches /message/ and
       * made this pass for a reason unrelated to what it asserts.
       */
      const copy = (fn.match(/(title|body): "[^"]*"/g) ?? []).join(" ")
      expect(copy).not.toMatch(/pseudonym|anonymous|\bname\b|\bsaid\b|\bwrote\b/)
      expect(copy.length).toBeGreaterThan(0)
    }
  })
})
