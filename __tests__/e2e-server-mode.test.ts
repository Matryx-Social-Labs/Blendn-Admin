import { readFileSync } from "fs"
import { join } from "path"

/**
 * The e2e lane starts the server in production mode.
 *
 * It did not, for as long as the lane existed. `npm run` does not set
 * NODE_ENV and nothing else in the workflow did, so a step named "Start the
 * production server" — in a job whose header says it "Runs against the
 * PRODUCTION server" — started Next.js in **development** mode. Its own log
 * said `NODE_ENV: undefined`, and nobody read it.
 *
 * The cost was not a slower lane. Next.js dev compiles routes on demand and
 * holds the module graphs, so the two sweeps' 231 navigations over 27 pages
 * drove the process to 6.5GB and the host reclaimed the runner. That was
 * diagnosed twice as an Actions quota problem and once, in writing, as a
 * probable production memory leak — because the failure was real, the
 * measurement was real, and the server was simply not the one being deployed.
 *
 * It never reproduced locally because scripts/e2e-local.ts passes
 * NODE_ENV: "production" on the spawn. The two paths that were supposed to
 * run the same thing differed by the one variable that decides what runs.
 *
 * This pins the PRODUCER — the assignment in the env prefix that reaches the
 * process — rather than the presence of the string somewhere in the file. A
 * guard on the string alone passes against a comment mentioning it.
 */
const CI = join(__dirname, "..", ".github", "workflows", "ci.yml")

/**
 * The env-assignment prefix immediately above `npm run start`: the contiguous
 * run of `KEY=value \` continuation lines that shell applies to that command.
 * Comments and blank lines end the run, so a mention inside the comment block
 * above it does not count.
 */
function envPrefixForServerStart(src: string): string[] {
  const lines = src.split("\n")
  const idx = lines.findIndex((l) => /npm run start/.test(l) && !/^\s*#/.test(l))
  if (idx === -1) return []

  const prefix: string[] = []
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i]
    if (!/\\\s*$/.test(line)) break // no continuation: the run has ended
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*?)\s*\\\s*$/.exec(line)
    if (!m) break
    prefix.push(`${m[1]}=${m[2].replace(/^["']|["']$/g, "")}`)
  }
  return prefix
}

describe("the e2e lane's server", () => {
  const src = readFileSync(CI, "utf8")

  it("finds the server start at all", () => {
    // The control for everything below: an absence and a miss look identical.
    expect(src).toMatch(/npm run start/)
    expect(envPrefixForServerStart(src).length).toBeGreaterThan(0)
  })

  it("reads the env prefix and not the comment above it", () => {
    // The detector, against the exact shape of the bug: NODE_ENV named in the
    // prose that explains it, and absent from the assignments.
    const commentOnly = [
      "        run: |",
      "          # NODE_ENV=production matters here",
      "          MEMORY_TRACE=1 \\",
      "            npm run start &",
    ].join("\n")
    expect(envPrefixForServerStart(commentOnly)).toEqual(["MEMORY_TRACE=1"])
  })

  it("starts in production mode", () => {
    const prefix = envPrefixForServerStart(src)
    expect({
      prefix,
      hint: prefix.includes("NODE_ENV=production")
        ? ""
        : "`npm run` does not set NODE_ENV. Without it Next.js starts in development mode, " +
          "compiles routes on demand, and the sweeps drive the process past 6GB until the " +
          "runner is reclaimed — while the step's name and the job header both say production.",
    }).toEqual({ prefix, hint: "" })
  })
})
