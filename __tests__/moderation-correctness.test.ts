import { readFileSync } from "fs"
import { join } from "path"

/**
 * Five ways the moderation pipeline told a moderator it had worked.
 *
 * `docs/ROADMAP.md:333` is blunt about the stakes: Yik Yak did not die of
 * indifference, it died of harassment. The stated differentiator is
 * accountability. Each of these five is the safety mechanism failing *and
 * reporting success*, which is worse than failing loudly — a moderator watching
 * a silent queue concluded the rooms were quiet.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("G3 — nothing is called clean that was not checked", () => {
  it("makes the check report whether it ran", () => {
    /*
     * `checkTextContent` returned `ModerationResult | null`, and null carried
     * four facts: clean, no API key, API error, and — in the inline path's race
     * — timed out. `OPENAI_API_KEY` is optional in `lib/env.ts` and listed as
     * not required in `DEPLOYMENT.md`, so the ordinary deployment recorded
     * every message as examined by a moderator that was never called.
     */
    const src = code("lib/moderation/openai-moderation.ts")
    expect(src).toMatch(/export type ModerationCheck/)
    expect(src).toMatch(/checked: false; reason: "no_key" \| "error" \| "timeout"/)
    // No path returns a bare null any more.
    expect(src).not.toMatch(/return null \/\/ Fail open/)
    expect((src.match(/notChecked\("(no_key|error)"\)/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it("writes unchecked rather than clean when nobody looked", () => {
    const src = code("lib/moderation/actions.ts")
    expect(src).toMatch(/export async function recordExamined/)
    expect(src).toMatch(/examined \? "clean" : "unchecked"/)
    // The old unconditional writer is gone, not merely unused.
    expect(src).not.toMatch(/export async function markClean/)
  })

  it("does not let the inline path claim a verdict it does not have", () => {
    /*
     * Both chat routes wrote `clean` at the end regardless — including when the
     * block above had just handed the message to the async pipeline. So the
     * inline write raced the pipeline's verdict and, being later, could
     * overwrite a `flagged` with a `clean`.
     */
    for (const rel of [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/events/[eventId]/chat/route.ts",
    ]) {
      const src = code(rel)
      expect(src).toMatch(/let examinedInline = false/)
      expect(src).toMatch(/examinedInline = openaiCheck\.checked/)
      expect(src).toMatch(/if \(\s*examinedInline &&/)
      // The length guard is gone: a slur is five characters.
      expect(src).not.toMatch(/content\.length > 5/)
    }
  })

  it("stops photos guessing whether they were moderated", () => {
    /*
     * `lib/photos.ts` already knew this distinction mattered and had to
     * approximate it: `verdict !== null || hasModerationKey()`. A configured
     * key plus an API error read as *checked* — the one combination where the
     * guess is wrong, and the one that happens during an outage.
     */
    const src = code("lib/photos.ts")
    // The vendor's own answer is what gets recorded -- now after the
    // response, in moderateProfilePhoto, but still never a guess.
    expect(src).toMatch(/recordPhotoCheck\(url, userId, check\.checked\)/)
    expect(src).not.toMatch(/hasModerationKey/)
  })

  it("shows the degraded count to a moderator", () => {
    // R13: `unchecked` is only worth having if somebody sees it.
    expect(code("app/dashboard/moderation/actions.ts")).toMatch(/moderation_status: "unchecked"/)
    expect(code("app/dashboard/moderation/page.tsx")).toMatch(/unchecked in the last hour/)
  })
})

describe("G4 — the keyword filter stops auto-hiding ordinary English", () => {
  it("separates a whole-word match from a separator-stripped one", () => {
    /*
     * `normalize` strips every separator, so "the flag" became "theflag", which
     * contains `fag` — auto-hidden at 0.85, and three auto-hides in an hour is
     * an auto-mute. The docstring claimed "exact-match on normalized tokens";
     * it was `String.includes`.
     */
    const src = code("lib/moderation/keyword-filter.ts")
    expect(src).toMatch(/function normalizeWords/)
    expect(src).toMatch(/function normalizeAggressive/)
    expect(src).toMatch(/exact\.length > 0 \? Math\.min\(1, 0\.85 \+ exact\.length \* 0\.05\) : 0\.5/)
  })
})

describe("G5 — a manual mute is not an automatic one", () => {
  it("records who applied a mute, as a ban already does", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
    expect(schema).toMatch(/muted_by\s+String\?/)
    expect(code("app/api/events/[id]/chat/members/[userId]/route.ts")).toMatch(
      // The shape moved to a conditional spread when `?? undefined` was
      // removed for `strictUndefinedChecks` (SCRUM-53). Same behaviour:
      // mute writes the actor, unmute nulls it, neither touches the other
      // pair. Only the text this greps for changed.
      /muted_at: new Date\(\), muted_by: session\.user\.id/
    )
  })

  it("only lets the timer lift a mute the timer applied", () => {
    /*
     * `checkAndAutoUnmute` cleared any `muted` status from anyone with fewer
     * than three recent auto-hide flags. An organiser's mute has zero, so
     * `0 < 3` held and it evaporated on the muted person's next message.
     */
    const src = code("lib/moderation/actions.ts")
    expect(src).toMatch(/muted_by: null,\s*\n\s*\},\s*\n\s*data: \{\s*\n\s*status: "active"/)
    expect(src).toMatch(/if \(count === 0\) return false/)
  })
})

describe("G8 — admin Keep actually keeps", () => {
  it("restores the message, matching the organiser's twin", () => {
    /*
     * The admin approve set the flag approved and never touched the message, so
     * an auto-hidden message stayed soft-deleted with no path back — while the
     * toast said "message kept". The flag left the queue, so nobody would look
     * again either.
     */
    const src = code("app/dashboard/moderation/actions.ts")
    expect(src).toMatch(/moderation_status: "clean", deleted_at: null/)
    expect(src).toMatch(/moderation_status: "hidden", deleted_at: new Date\(\)/)
  })
})

describe("G13 — the burst limit is one bucket, not one per replica", () => {
  it("counts bursts in the shared store", () => {
    const src = code("lib/moderation/spam-detector.ts")
    expect(src).toMatch(/await hit\(`spam:burst:\$\{key\}`, SPAM_BURST_WINDOW_MS\)/)
  })

  it("resets both halves of the state together", () => {
    /*
     * Not a test-only concern. The burst counter left the local Map, so a reset
     * that cleared only the Map left the window running — the counter and the
     * history would disagree about whether this person had just spoken.
     */
    const src = code("lib/moderation/spam-detector.ts")
    expect(src).toMatch(/export async function resetSpamHistory/)
    expect(src).toMatch(/await forget\(`spam:burst:\$\{key\}`\)/)
    expect(src).toMatch(/export async function clearAllSpamHistory/)
  })
})

describe("contact details are detected on every write path, not one of them", () => {
  /*
   * Two routes write `chat_messages`, and only `chat/groups/[chatGroupId]`
   * ran `checkContactInfo`. `events/[eventId]/chat` — the event room, which is
   * the surface this product is actually about — did not, so a phone number or
   * a handle posted there raised nothing at all.
   *
   * Measured before the fix by posting "add me on whatsapp 9876543210" into a
   * live event room: message stored, zero flags. `contact-info.ts`'s own
   * docstring says it runs "server-side before persist", which was true of one
   * of the two paths.
   *
   * The check moved into `moderateMessage`, which both routes call — the same
   * argument as every resolver here: the mechanism was right and using it was
   * optional.
   */

  it("runs the check inside the pipeline", () => {
    const src = code("lib/moderation/index.ts")
    expect(src).toMatch(/checkContactInfo\(content\)/)
  })

  it("stops after flagging, so the status is not overwritten", () => {
    /*
     * `recordExamined` writes `moderation_status` unconditionally, so falling
     * through to it overwrites `flagged` with `unchecked` and leaves the
     * message contradicting its own flag row.
     *
     * That is exactly what happened on the first attempt, and it was found by
     * posting a message and reading the row back — not by reading the code.
     * The flag was created correctly and the status still said `unchecked`.
     */
    const src = code("lib/moderation/index.ts")
    const contactAt = src.indexOf("checkContactInfo(content)")
    const recordAt = src.indexOf("recordExamined(")
    expect(contactAt).toBeGreaterThan(-1)
    expect(recordAt).toBeGreaterThan(contactAt)
    // A bare `return` guarded by the contact result, between the two.
    expect(src.slice(contactAt, recordAt)).toMatch(/if \(contactResult\) return/)
  })

  it("leaves neither send route running its own copy", () => {
    /*
     * One pipeline, or the next route to be added inherits the choice of
     * whether to bother. `flagForReview` is a bare `create` with no unique
     * constraint behind it, so a route flagging as well as the pipeline puts
     * the same message in the queue twice.
     */
    const routes = [
      "app/api/mobile/events/[eventId]/chat/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
    ]
    const offenders = routes.filter((r) => /checkContactInfo\s*\(/.test(code(r)))
    expect({ offenders, hint: offenders.length ? "moderateMessage already does this" : "" })
      .toEqual({ offenders: [], hint: "" })
  })
})
