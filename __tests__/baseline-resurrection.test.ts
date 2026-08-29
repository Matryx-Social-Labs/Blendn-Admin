import { readdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * The baseline may not create anything a later migration drops.
 *
 * ## The failure this exists for, which was live
 *
 * `20260101_baseline` was generated with `migrate diff --from-empty` and
 * therefore describes the schema *as it is today*. Everything in it is
 * `IF NOT EXISTS`, which makes it a safe no-op on a database that already has
 * the objects — and that safety is exactly what hid the problem.
 *
 * Migrations apply in name order, and the baseline sorts **first**. On a fresh
 * install that is correct: the baseline creates
 * `event_check_ins_event_id_user_id_key`, and `20260807_event_occurrences`
 * drops it moments later, replacing it with a unique on
 * `(occurrence_id, user_id)` so a multi-day event can hold a row per person per
 * day.
 *
 * On a **deployed** database the order is not the file order. Staging recorded
 * `20260807` months ago, so the baseline is pending and applies *after* it —
 * and re-creates the unique that migration existed to remove. Nothing errors.
 * The deploy succeeds. And a second-day check-in then violates a unique
 * constraint, which is multi-day attendance made silently impossible on the
 * mechanic the product is built on.
 *
 * It was found by replaying the chain against a schema-only copy of staging
 * rather than against an empty database, and it would not have been found any
 * other way: a fresh install ends in the right state, so every local check —
 * `migrate deploy`, `migrate status`, a column diff — was green.
 *
 * ## What this asserts
 *
 * Nothing named in a `DROP` in any later migration may be created by the
 * baseline. Two instances existed: the index above, and
 * `profiles.push_token` / `push_platform`, which `20260309_phase1_fixes`
 * removed once every token moved to `push_tokens`.
 */
const MIGRATIONS = join(__dirname, "..", "prisma", "migrations")
const BASELINE = "20260101_baseline"

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/**
 * A migration's SQL with its comments stripped.
 *
 * Stripping matters more than it sounds. The fix for the resurrection bug was
 * to delete the offending `CREATE` and leave a comment in its place explaining
 * why the object is deliberately absent — and that comment names the index. A
 * guard reading raw text then reports the very note that records the fix, which
 * would have left exactly two choices: weaken the guard, or delete the
 * explanation. Both are worse than parsing slightly more carefully.
 */
const sqlOf = (name: string): string => {
  const f = join(MIGRATIONS, name, "migration.sql")
  if (!existsSync(f)) return ""
  return readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
}

/** Names dropped by a migration: indexes, constraints, columns and tables. */
function droppedNames(sql: string): Array<{ kind: string; name: string }> {
  const out: Array<{ kind: string; name: string }> = []
  const patterns: Array<[string, RegExp]> = [
    ["index", /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi],
    ["constraint", /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi],
    ["column", /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi],
    ["table", /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi],
  ]
  for (const [kind, re] of patterns) {
    for (const m of sql.matchAll(re)) out.push({ kind, name: m[1] })
  }
  return out
}

/**
 * Does the baseline create this name?
 *
 * A quoted occurrence in the *code* is the test; `sqlOf` has already removed
 * comments. It still over-matches — a name appearing in an unrelated statement
 * counts — and that is the safe direction for a guard whose failure mode is a
 * silent resurrection on a live database.
 */
const baselineCreates = (sql: string, name: string) => sql.includes(`"${name}"`)

describe("the baseline does not resurrect what later migrations remove", () => {
  const baseline = sqlOf(BASELINE)
  const later = migrationDirs().filter((d) => d !== BASELINE)

  it("finds the baseline and the migrations after it", () => {
    /*
     * The control. The assertion below is an absence, and an absence is also
     * what a wrong directory name, an empty read or a broken glob produces.
     */
    expect(baseline.length).toBeGreaterThan(10_000)
    expect(later.length).toBeGreaterThan(40)
    expect(later.some((d) => d === "20260807_event_occurrences")).toBe(true)
  })

  it("detects a resurrection when there is one", () => {
    // The detector, against known-bad input — the exact shape that was live.
    const dropped = droppedNames(
      `DROP INDEX IF EXISTS "event_check_ins_event_id_user_id_key";`
    )
    expect(dropped).toEqual([
      { kind: "index", name: "event_check_ins_event_id_user_id_key" },
    ])
    expect(baselineCreates(`CREATE UNIQUE INDEX "foo" ON "bar"("baz");`, "foo")).toBe(true)
    expect(baselineCreates(`CREATE UNIQUE INDEX "foo" ON "bar"("baz");`, "nope")).toBe(false)
  })

  it("creates nothing that a later migration drops", () => {
    const resurrected: string[] = []
    for (const dir of later) {
      for (const { kind, name } of droppedNames(sqlOf(dir))) {
        if (baselineCreates(baseline, name)) {
          resurrected.push(`${BASELINE} creates ${kind} "${name}", which ${dir} drops`)
        }
      }
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      resurrected,
      hint: resurrected.length
        ? "Migrations apply in name order, so the baseline sorts first — but on a deployed " +
          "database it applies AFTER the migrations already recorded there. Anything it " +
          "creates that a later migration drops comes back, silently, and that migration " +
          "will not run again to remove it. Delete it from the baseline: a fresh install " +
          "reaches the same end state without it, because the later DROP is IF EXISTS."
        : "",
    }).toEqual({ resurrected: [], hint: "" })
  })
})
