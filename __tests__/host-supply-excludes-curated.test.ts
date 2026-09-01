import { readFileSync } from "fs"
import { join } from "path"

/**
 * A supply question keyed on `organizer_id` must exclude curated events.
 *
 * ## The number said the opposite of what it is for
 *
 * Curated events carry `organizer_id = <the admin who curated them>`, because
 * that column records who *created* the row. Three organiser-keyed queries on
 * the admin overview read it directly, so with three curated events the screen
 * reported `PUBLISHING HOSTS 2 of 3` and listed a founder in "Supply by
 * organiser" with 3 published.
 *
 * Host liquidity answers *"are real organisers publishing?"*, and the premise
 * of curation is that they are not yet and we are filling the gap ourselves.
 * Counting the person doing the filling as supply makes the metric report a
 * healthy host base made entirely of us — the one conclusion it exists to
 * prevent. Curate harder and it looks better.
 *
 * ## Why a grep guard rather than a unit test
 *
 * The defect is not arithmetic; every one of those queries was individually
 * correct. It is a *column choice*, repeated at three call sites, and the
 * fourth one somebody adds will be correct in the same way. `hostSupply()`
 * exists so the choice is made once, and this fails the build when a new
 * organiser-keyed query goes around it.
 *
 * Same shape as `authz-scoping-boundary.test.ts`, which fails on a hand-rolled
 * `organizer_id !==` for the same underlying reason: `organizer_id` answers a
 * different question from the one being asked.
 */

const ROOT = join(__dirname, "..")
const ACTIONS = join(ROOT, "app", "dashboard", "actions.ts")

/** Strip comments — this file's docblocks name both functions repeatedly. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

/**
 * Read a brace-matched block starting at `from`.
 *
 * Not a negated character class. Two guards in this repo were vacuous because
 * `[^}]*` stops at the first nested `}` — a sibling `where: { ... }` is enough
 * — and both were caught by running the control rather than by reading the
 * test. The rule that came out of it: a structural guard may not use a negated
 * character class to cross a delimiter.
 */
function blockAt(src: string, from: number): string {
  const open = src.indexOf("{", from)
  if (open === -1) return ""
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

describe("organiser-keyed supply queries exclude curated events", () => {
  const src = strip(readFileSync(ACTIONS, "utf8"))

  it("finds the queries at all", () => {
    // Guards the walker. A regex that matches nothing makes the assertion
    // below vacuous, which is the failure R16's controls exist to catch.
    const found = [...src.matchAll(/(by|distinct):\s*\[\s*"organizer_id"/g)]
    expect(found.length).toBeGreaterThanOrEqual(3)
  })

  it("keys every one of them on hostSupply, not eventScope", () => {
    const offenders: string[] = []

    for (const match of src.matchAll(/db\.events\s*\n?\s*\.?(groupBy|findMany)\(/g)) {
      const block = blockAt(src, match.index!)
      // Only the organiser-keyed ones. A city or status query may scope
      // however it likes — curated supply is real supply, it is just not a
      // *host's*, and the distinction only matters when the key is a person.
      if (!/(by|distinct):\s*\[\s*"organizer_id"/.test(block)) continue
      if (/hostSupply\(/.test(block)) continue
      offenders.push(block.replace(/\s+/g, " ").slice(0, 110))
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // second-argument message is a Playwright idiom that throws here.
    expect({
      offenders,
      hint:
        offenders.length > 0
          ? "Use hostSupply() — organizer_id on a curated event is the admin who created it, " +
            "so this query counts us as a host."
          : "",
    }).toEqual({ offenders: [], hint: "" })
  })
})
