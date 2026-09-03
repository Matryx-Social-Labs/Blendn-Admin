import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * The workflow files parse the way GitHub parses them, not the way a permissive
 * loader does.
 *
 * A duplicate mapping key is valid to most YAML libraries — they keep the last
 * one and say nothing — and **invalid to GitHub**, which refuses the workflow
 * outright. The result is not a helpful error: the run is created, no job
 * matches, and it is reported as a plain red failure that looks exactly like a
 * broken test.
 *
 * That is not hypothetical. An `if:` gate was added to the `e2e` job while
 * another branch had already merged one, so the job carried two. Every run on
 * that branch came back `failure` with **zero jobs**, and no `pull_request`
 * check fired at all, for three commits — while `yaml.safe_load` reported the
 * file as parsing cleanly each time it was checked.
 *
 * A checker more permissive than the thing it stands in for is worse than no
 * checker: it converts an unknown into a false assurance. That is the same
 * failure the negative-control registry exists to catch, arriving through
 * tooling rather than through a test.
 */
const WORKFLOWS = join(__dirname, "..", ".github", "workflows")

/**
 * Duplicate top-level and nested mapping keys, found by scanning indentation.
 *
 * Deliberately not a YAML parser: every parser this could use is the permissive
 * one whose behaviour caused the bug. Line-based, indentation-aware, and
 * limited to `key:` at a given depth within a block — which is exactly the
 * shape the real defect took (two `if:` keys under one job).
 */
function duplicateKeys(src: string): string[] {
  const dupes: string[] = []
  // depth -> keys seen since that depth was last entered
  const seen = new Map<number, Set<string>>()
  let lastIndent = -1

  src.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line) || line.trim() === "") return
    const m = /^(\s*)(-\s+)?([A-Za-z_][\w-]*):(\s|$)/.exec(line)
    if (!m) return
    const indent = m[1].length
    const key = m[3]

    // A list item starts a fresh mapping, so its keys are not duplicates of the
    // previous item's.
    if (m[2]) seen.delete(indent)

    for (const depth of [...seen.keys()]) {
      if (depth > indent) seen.delete(depth)
    }
    if (indent > lastIndent) seen.delete(indent)

    const at = seen.get(indent) ?? new Set<string>()
    if (at.has(key)) dupes.push(`line ${i + 1}: duplicate key "${key}" at indent ${indent}`)
    at.add(key)
    seen.set(indent, at)
    lastIndent = indent
  })
  return dupes
}

describe("GitHub workflow files", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))

  it("finds the workflows at all", () => {
    // The control: everything below is an absence, and an empty directory
    // produces the same result as a clean one.
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain("ci.yml")
  })

  it("detects a duplicate when there is one", () => {
    /*
     * The detector, against the exact shape that shipped: two `if:` keys under
     * one job.
     */
    const bad = ["jobs:", "  e2e:", "    if: a", "    runs-on: ubuntu-latest", "    if: b"].join("\n")
    expect(duplicateKeys(bad)).toHaveLength(1)
    expect(duplicateKeys(bad)[0]).toMatch(/duplicate key "if"/)

    // And that it does not object to the same key under different jobs, which
    // is ordinary and must stay legal.
    const fine = ["jobs:", "  a:", "    if: x", "  b:", "    if: y"].join("\n")
    expect(duplicateKeys(fine)).toEqual([])
  })

  it("has no duplicate keys", () => {
    const offenders = files.flatMap((f) =>
      duplicateKeys(readFileSync(join(WORKFLOWS, f), "utf8")).map((d) => `${f} ${d}`)
    )

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      offenders,
      hint: offenders.length
        ? "GitHub rejects a workflow with duplicate mapping keys. The run is created, no job " +
          "matches, and it reports as a plain failure with zero jobs — indistinguishable from " +
          "a broken test. Most YAML loaders accept it silently, so a parse check will not."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })
})
