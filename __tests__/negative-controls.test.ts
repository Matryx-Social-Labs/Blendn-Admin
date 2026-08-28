import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * R16, made enforceable.
 *
 * This codebase leans hard on *structural* guards — tests that read source and
 * assert a shape, rather than calling code and asserting a result. They are the
 * right tool for the failure this project keeps having: a capability that is
 * built, typechecked, unit-tested and called by nobody.
 *
 * But a structural guard has a failure mode a behavioural test does not. A grep
 * that never matches passes. A regex with a typo passes. A test asserting a
 * function has callers passes when the only "caller" is a comment. In every
 * case the suite is green and the guard is doing nothing, which is worse than
 * having no guard at all — an unknown has been converted into a false
 * assurance. This project has already shipped one `sed`-based control that
 * silently never matched.
 *
 * The only way to know a guard works is to break the thing it guards and watch
 * it fail. R16 says every guard ships with that mutation recorded. This test is
 * the enforcement.
 *
 * ## The ratchet
 *
 * Twenty-six guards predate the registry and have no recorded control. Failing
 * the build on all of them would mean either a day of mutation testing before
 * anything else can land, or — far more likely — someone deleting this test.
 * So they are grandfathered, and the list may shrink and must never grow.
 *
 * A new structural guard with no entry fails here. That is the point: the cost
 * lands on the person adding a guard, while they still have the mutation in
 * their head, rather than on whoever inherits it.
 *
 * (An earlier draft of this comment cited
 * `server-actions-reachable.test.ts`'s `KNOWN_UNREACHABLE` as prior art for the
 * shape. That file is not on `dev` — it was written in an earlier session and
 * never landed. Citing it here was the seventeenth instance of the thing this
 * codebase keeps doing: a comment describing something that is not there.
 * `fix/reachability-ratchet` is bringing a version of it in.)
 */
const TESTS_DIR = __dirname
const REGISTRY = JSON.parse(
  readFileSync(join(TESTS_DIR, "negative-controls.json"), "utf8")
) as {
  verified: Record<string, { guards: string; mutation: string; observed: string; date: string }>
  grandfathered: string[]
}

/**
 * A structural guard: a test that reads source files.
 *
 * The heuristic is `readFileSync` in a test, which is exactly how every guard
 * in this suite inspects code. A behavioural test that mocks the database and
 * calls a route handler does not need a recorded mutation — if the assertion is
 * wrong, the test fails on its own terms rather than passing vacuously.
 */
function structuralGuards(): string[] {
  /*
   * Both directories, because the first structural guard written inside an
   * integration suite escaped this registry completely.
   *
   * The scan was top-level `*.test.ts` only, so a guard living in
   * `integration/*.itest.ts` was invisible: it needed no entry, and an entry
   * added for it read as *stale* and failed the build. That is the R16 hole in
   * miniature — a guard nobody has to verify — and it was found by writing one
   * rather than by reading this.
   *
   * Keyed by basename, which the registry already uses and which is unique
   * across the two directories.
   */
  const roots: Array<[string, (f: string) => boolean]> = [
    [TESTS_DIR, (f) => f.endsWith(".test.ts")],
    [join(TESTS_DIR, "integration"), (f) => f.endsWith(".itest.ts")],
  ]

  return roots
    .flatMap(([dir, matches]) =>
      readdirSync(dir)
        .filter(matches)
        .filter((f) => f !== "negative-controls.test.ts")
        .filter((f) => readFileSync(join(dir, f), "utf8").includes("readFileSync"))
    )
    .sort()
}

describe("every structural guard has a recorded negative control", () => {
  it("fails on a new guard with no entry", () => {
    const known = new Set([...Object.keys(REGISTRY.verified), ...REGISTRY.grandfathered])
    const missing = structuralGuards().filter((f) => !known.has(f))

    expect({
      missing,
      hint:
        missing.length > 0
          ? "Break the thing this guard protects, run the suite, confirm it fails, revert, " +
            "then add an entry to __tests__/negative-controls.json under `verified`."
          : "",
    }).toEqual({ missing: [], hint: "" })
  })

  it("does not let the grandfathered list grow", () => {
    /*
     * Pinned to the count at the moment the registry was written. Lowering this
     * is the whole point; raising it means somebody added a guard to the
     * backlog instead of verifying it, which is the habit this exists to break.
     */
    expect(REGISTRY.grandfathered.length).toBeLessThanOrEqual(26)
  })

  it("has no entry that is both verified and grandfathered", () => {
    const both = REGISTRY.grandfathered.filter((f) => f in REGISTRY.verified)
    expect(both).toEqual([])
  })

  it("lists no guard that no longer exists", () => {
    /*
     * A registry that names deleted files quietly overstates coverage, and the
     * grandfathered count stops meaning anything.
     */
    const present = new Set(structuralGuards())
    const stale = [...Object.keys(REGISTRY.verified), ...REGISTRY.grandfathered].filter(
      (f) => !present.has(f)
    )
    expect(stale).toEqual([])
  })
})

describe("a verified entry actually says something", () => {
  for (const [file, entry] of Object.entries(REGISTRY.verified)) {
    it(`${file} records a mutation and what it broke`, () => {
      /*
       * "Changed the code and it failed" is not a control. The entry has to name
       * the specific mutation and the specific assertion that caught it, or
       * nobody can re-run it — and a control nobody can re-run decays into a
       * claim.
       */
      expect(entry.guards.length).toBeGreaterThan(20)
      expect(entry.mutation.length).toBeGreaterThan(20)
      expect(entry.observed).toMatch(/failing|fails/i)
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  }
})
