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
    expect(src).toMatch(/checked: check\.checked/)
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
      /muted_by: action === "mute" \? session\.user\.id/
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
