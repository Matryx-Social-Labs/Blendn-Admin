import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * `_count.check_ins` is as unwelcome in a query as a hand-rolled
 * `organizer_id !==`.
 *
 * `event_check_ins` is `@@unique([occurrence_id, user_id])` — one row per person
 * **per day**, deliberately, so "who came on Wednesday" has an answer. Prisma's
 * `_count` has no DISTINCT, so every `_count.check_ins` returns attendance-days
 * while the field it feeds is labelled people. On a three-day conference all of
 * them read three times high.
 *
 * Eight call sites did this, and they disagreed about the question as well as
 * the answer — `status IN (checked_in, checked_out)`, `status = checked_in`,
 * `check_in_time IS NOT NULL`, and a fifth `ATTENDED` hand-rolled locally in a
 * page file. That is the shape of every finding in this audit: a question with
 * more than one answer and no module that owns it.
 *
 * `lib/attendee-counts.ts` owns it now. This test is what stops the ninth.
 */

const ROOT = join(__dirname, "..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Comments describe the bug; only code can reintroduce it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
}


/** Every balanced `{...}` following a `_count:` key. */
function countBlocks(src: string): string[] {
  const blocks: string[] = []
  const key = /_count\s*:\s*\{/g
  let m: RegExpExecArray | null
  while ((m = key.exec(src)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") depth--
    }
    blocks.push(src.slice(m.index, i))
  }
  return blocks
}

/**
 * The one place a row count is the honest answer.
 *
 * The admin users table renders this as **"12 check-ins"** — not "12 events" —
 * so attendance-days is exactly what the label claims. Every other site said
 * "people" or "events attended" and got days.
 *
 * This list may shrink and must never grow. A new entry means somebody is about
 * to render attendance-days under a people-shaped label.
 */
const ROW_COUNTS_ARE_HONEST_HERE = ["app/dashboard/users/actions.ts"]

describe("counting people, not rows", () => {
  const files = [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]

  it("has no `_count` on check-ins anywhere in lib/ or app/", () => {
    const offenders = files.filter((f) => {
      const src = code(f)
      // Reading it back off the payload.
      if (/_count\.(event_)?check_ins\b/.test(src)) return true
      // Or selecting it in the first place. Brace-matched, not `[^}]*`: a
      // sibling like `rsvps: { where: { status: "going" } }` contains braces,
      // and a character-class version silently stops at the first one — which
      // is how the first draft of this guard passed against broken code.
      return countBlocks(src).some((b) => /\b(event_)?check_ins\s*:/.test(b))
    })
    expect(
      offenders
        .map((f) => f.slice(ROOT.length + 1))
        .filter((f) => !ROW_COUNTS_ARE_HONEST_HERE.includes(f))
    ).toEqual([])
  })

  it("keeps the allowlist honest", () => {
    // An entry that no longer matches is an entry that has been fixed; drop it.
    for (const allowed of ROW_COUNTS_ARE_HONEST_HERE) {
      expect(code(join(ROOT, allowed))).toMatch(/\bevent_check_ins\s*:/)
    }
  })

  it("asks one question about what counts as attended", () => {
    /*
     * The predicate lives in the module, once. `status = 'checked_in'` alone was
     * the sharpest of the four variants: the mobile feed's headline count
     * dropped every time somebody checked out, so an event's number fell while
     * it was at its busiest.
     */
    const src = code(join(ROOT, "lib/attendee-counts.ts"))
    expect(src).toMatch(/COUNT\(DISTINCT user_id\)/)
    expect(src).toMatch(/COUNT\(DISTINCT event_id\)/)
    // Both folds exclude staff, who attend every day by definition.
    expect((src.match(/kind = 'attendee'/g) ?? []).length).toBe(2)
  })

  it("does not clamp turn-up to 100", () => {
    /*
     * The clamp was justified as absorbing walk-ins and in practice absorbed the
     * row inflation — which hid the walk-ins it named. Walk-in volume is the one
     * signal that says an event outperformed its RSVPs, so 130% is information.
     *
     * Scoped to turn-up deliberately. `fillPct` against a declared capacity and
     * the bar-width clamp in `lib/dashboard-view.ts` are different questions:
     * a progress bar genuinely cannot exceed its track.
     */
    const offenders = files.filter((f) =>
      /turnUp[^\n]*\n?[^\n]*Math\.min\(100,|Math\.min\(100,[^\n]*turnUp/i.test(code(f))
    )
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
  })
})
