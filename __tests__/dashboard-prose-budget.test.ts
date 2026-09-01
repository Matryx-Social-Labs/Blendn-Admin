import { readFileSync, readdirSync } from "fs"
import { join, relative, sep } from "path"

/**
 * A dashboard page explains itself in one short line, or not at all.
 *
 * ## Why there is a budget at all
 *
 * `components/site-header.tsx` already renders every page's title and a
 * one-line description. A paragraph at the top of the page is therefore a
 * *second* explanation of the same screen, and the ones here had drifted into
 * restating the first in longer words:
 *
 *   header — "Ownership requests. Approving one hands over a brand's name and
 *             its reporting."
 *   page   — "Oldest first. Approving hands over the brand name, the logo shown
 *             beside every sponsored message, and the reporting on placements
 *             other people set up. It does not grant the right to place a
 *             sponsored message — that is the sponsoring grant on the
 *             organisation, set separately."
 *
 * Across six screens that was 1,355 characters of prose above the fold, and
 * cutting the restatement removed 43% of it without losing a single rule.
 *
 * The rule that produced those edits, and that this budget enforces: **the
 * header owns "what this screen is". A page paragraph earns its place only by
 * stating a rule the reader cannot infer — and then it says only the rule.**
 *
 * ## Why a character count rather than something cleverer
 *
 * Whether a sentence restates its header is a judgement no test can make. How
 * long it is, is not. A cap does not catch bad prose, but it does catch the
 * failure that actually happened — explanation accumulating a clause at a time,
 * each one defensible on its own, until the screen leads with a paragraph.
 *
 * The budget is deliberately loose. It is a ceiling on a habit, not a style
 * guide, and anything under it is a judgement call left to the person writing.
 */

const ROOT = join(__dirname, "..")
const DASHBOARD = join(ROOT, "app", "dashboard")

/** Comfortably above every current page, and well below where they started. */
const MAX_CHARS = 180

function pageFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pageFiles(join(dir, entry.name), acc)
    else if (entry.name === "page.tsx") acc.push(join(dir, entry.name))
  }
  return acc
}

/** Code comments and JSX comments both mention this copy; neither renders. */
const strip = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

describe("dashboard pages do not re-explain themselves", () => {
  const files = pageFiles(DASHBOARD)

  it("finds the pages at all", () => {
    // Guards the walker. A broken walk makes the budget below vacuous while
    // reporting a pass, which is the failure R16's controls exist to catch.
    expect(files.length).toBeGreaterThan(30)
  })

  it("keeps every literal explanatory paragraph inside the budget", () => {
    const over: string[] = []

    for (const file of files) {
      const src = strip(readFileSync(file, "utf8"))
      /*
       * Literal prose only. A `<p>` opening with `{` is rendering data — a
       * formatted date, a venue address, a branch on the viewer's role — and
       * its length is a property of the row, not of how much somebody chose to
       * explain. Budgeting it would be measuring the wrong thing.
       *
       * The "opens with `{`" test is done here, in code, and not in the pattern.
       * The first version tried `>\s*([^<{]…)` and it did not work: `\s*` is
       * greedy but it **backtracks**, so against `>\n    {canOwn` the engine
       * gave a space back and `[^<{]` matched the space rather than rejecting
       * the brace. The guard reported a data expression as prose.
       *
       * That is this repo's recurring vacuous-guard shape in a new costume —
       * previously `[^}]*` and `[^)]*` crossing a nested delimiter. The rule
       * generalises: a structural guard should not lean on a negated character
       * class to make a positional claim, because an adjacent quantifier can
       * always hand it a different character to match.
       */
      for (const m of src.matchAll(/<p[^>]*text-muted-foreground[^>]*>([^<]*)<\/p>/g)) {
        const text = m[1].replace(/\s+/g, " ").trim()
        if (text.startsWith("{")) continue
        if (text.length <= MAX_CHARS) continue
        over.push(`${relative(ROOT, file).split(sep).join("/")} — ${text.length} chars: "${text.slice(0, 70)}…"`)
      }
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      over,
      hint:
        over.length > 0
          ? `Over ${MAX_CHARS} characters. site-header already says what this screen is — ` +
            "keep only the rule a reader cannot infer, and say only the rule."
          : "",
    }).toEqual({ over: [], hint: "" })
  })
})
