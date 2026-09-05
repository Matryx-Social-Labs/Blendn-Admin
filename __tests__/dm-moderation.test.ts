import { readFileSync } from "fs"
import { join } from "path"

jest.mock("@/lib/moderation/spam-detector", () => ({ checkSpam: jest.fn() }))

import { checkSpam } from "@/lib/moderation/spam-detector"
import { screenDirectMessage } from "@/lib/dm-moderation"

/**
 * The one channel nothing was watching.
 *
 * `lib/moderation` was imported by exactly two files and both were group chat,
 * so a direct message received no keyword check, no spam check and no
 * contact-info check — in the channel where somebody is alone with a stranger,
 * and the one `contact-info.ts`'s own docstring names as where the harm it
 * targets lands.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/**
 * The brace-matched block introduced by `marker`.
 *
 * Brace-matched rather than sliced with a negated character class: `[^}]*`
 * stops at the first nested `}`, and this project has shipped four vacuous
 * guards that way — a sibling `where: { ... }` or an arrow function's parameter
 * list is enough to end the slice early and pass against broken code.
 */
function blockAfter(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const open = src.indexOf("{", start)
  if (open === -1) throw new Error(`no block after: ${marker}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced block after: ${marker}`)
}

const spam = checkSpam as jest.MockedFunction<typeof checkSpam>

const screen = (text: string | null) =>
  screenDirectMessage({ senderId: "u1", conversationId: "c1", text })

beforeEach(() => {
  spam.mockReset()
  spam.mockResolvedValue(null)
})

describe("what the deterministic checks do to a direct message", () => {
  it("passes an ordinary message with no verdict at all", async () => {
    /*
     * NULL, not "clean", and the distinction is the point. No model runs on
     * DMs, so there is no clean bill to record — writing one would be G3 in a
     * new table: an unchecked message stored as checked.
     */
    await expect(screen("see you at eight")).resolves.toEqual({
      verdict: "allow",
      status: null,
    })
  })

  it("refuses a flood rather than hiding it", async () => {
    /*
     * A flood is the one failure the recipient feels immediately, because every
     * message is a push. So it is stopped at the door, and the sender is told —
     * unlike a slur, where telling them the rule is most of what they wanted.
     */
    spam.mockResolvedValue({
      action: "hide",
      reason: "Too fast",
      confidence: 1,
      categories: {},
      source: "spam",
    })
    await expect(screen("hi")).resolves.toMatchObject({ verdict: "refuse", code: "spam" })
  })

  it("scopes the flood counter to the conversation, not the sender", async () => {
    /*
     * Somebody messaging ten different people is not flooding any of them.
     * Scoping to the sender alone would throttle an active user as though they
     * were harassing one person.
     */
    await screen("hello")
    expect(spam).toHaveBeenCalledWith("u1", "c1", "hello")
  })

  it("hides a slur, and stores it", async () => {
    await expect(screen("you fucking retard")).resolves.toEqual({
      verdict: "hide",
      status: "hidden",
    })
  })

  it("flags contact details and delivers them", async () => {
    /*
     * Never refused. Refusing teaches the sender exactly where the boundary is,
     * and the next attempt is spelled out with nothing behind it — the group
     * path's argument, and it applies here more strongly, because a DM is where
     * moving a conversation off-platform actually lands.
     */
    await expect(screen("whatsapp me on 9876543210")).resolves.toEqual({
      verdict: "allow",
      status: "flagged",
    })
  })

  it("has nothing to say about a photo with no caption", async () => {
    /*
     * Media moderation is the model's job and the model does not run here.
     * Claiming a verdict on an image nobody looked at would be the same
     * overstatement as writing "clean".
     */
    await expect(screen(null)).resolves.toEqual({ verdict: "allow", status: null })
    expect(spam).not.toHaveBeenCalled()
  })
})

describe("the visibility predicate", () => {
  it("matches a NULL verdict explicitly, not with a bare `not`", () => {
    /*
     * In SQL `moderation_status <> 'hidden'` is NULL for a NULL row and
     * therefore false. NULL is the ordinary case here — almost every message
     * has no verdict — so a bare `not` hides **the entire message history of
     * every conversation in the product**, silently.
     *
     * Confirmed against real Postgres in `dm-gating.itest.ts`, where replacing
     * this with `{ not: "hidden" }` makes an ordinary message disappear. This
     * assertion is the cheap guard beside that expensive one.
     */
    const src = codeOnly(read("lib", "dm-moderation.ts"))
    const decl = src.slice(src.indexOf("export const VISIBLE_DM"))
    expect(decl).toContain("moderation_status: null")
  })

  it("is carried by every participant-facing read of a DM", () => {
    /*
     * Three readers need it and the third is the one that gets forgotten: the
     * thread, the inbox's last-message preview, and the unread count. A hidden
     * message is never delivered, so it is never marked read — leaving it in
     * the count is a badge nobody can clear on a thread with nothing to clear.
     *
     * The two moderation reads are excluded deliberately and by name: an admin
     * reviewing a report must see the hidden message, since the row is the only
     * record a report can rest on.
     */
    const thread = codeOnly(
      read("app", "api", "mobile", "conversations", "[conversationId]", "messages", "route.ts")
    )
    expect(blockAfter(thread, "const whereClause")).toContain("VISIBLE_DM")

    /*
     * Both uses in the inbox are located, not merely counted.
     *
     * A first version asserted the file *contained* `VISIBLE_DM`, and the
     * control proved that vacuous: deleting it from the unread count left the
     * preview's copy behind and the guard stayed green. Asserting the presence
     * of a symbol somewhere in a file says nothing about the query that needed
     * it — which is the same mistake as pinning a value's consumer rather than
     * its producer, already recorded twice in this project.
     */
    const inbox = codeOnly(read("app", "api", "mobile", "conversations", "route.ts"))
    expect(blockAfter(inbox, "messages: {")).toContain("VISIBLE_DM")
    expect(blockAfter(inbox, "_count: {")).toContain("VISIBLE_DM")

    const MODERATION_READS = [
      // Reviewing a report. Must see what was hidden.
      ["app", "dashboard", "moderation", "reports", "actions.ts"],
      // Checking a reported id belongs to the conversation being left.
      ["app", "api", "mobile", "conversations", "[conversationId]", "leave", "route.ts"],
    ]
    for (const file of MODERATION_READS) {
      expect(codeOnly(read(...file))).not.toContain("VISIBLE_DM")
    }
  })
})
