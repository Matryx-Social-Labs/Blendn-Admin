import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * No recurring job may use `setInterval` with an async body.
 *
 * `setInterval` fires on a fixed schedule regardless of whether the previous
 * pass finished, so a pass slower than the interval starts the next one on top
 * of itself — and each overlapping pass makes the thing it is waiting on
 * slower, which makes the next pass longer. The failure is not a slow job, it
 * is a queue that cannot drain.
 *
 * This is not theoretical here. Production logs show
 * `Sentiment sweep failed … "Server has closed the connection."` — a dropped
 * Postgres connection, which is exactly the kind of stall that makes a pass
 * outlast its interval.
 *
 * Self-scheduling from a `finally` gives both properties at once: passes cannot
 * overlap, and a throwing pass still schedules its successor. A loop that stops
 * is silent — the presence sweeper stopping means nobody is ever checked out.
 */

const ROOT = join(__dirname, "..")

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const code = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

/**
 * The one legitimate `setInterval`, and why.
 *
 * `SponsoredMessageScheduler` arms one timer per campaign at a fixed cadence
 * that is the *product* behaviour — "every 15 minutes" is what the sponsor
 * bought, and a slow send should not push the next one later. Its `send()`
 * swallows its own errors and stops its own timer when the room closes.
 */
const ALLOWED = new Set(["lib/socket-server.ts"])

describe("recurring work schedules itself", () => {
  const files = sourceFiles(join(ROOT, "lib"))
    .map((f) => [f.replace(`${ROOT}/`, ""), f] as const)
    .filter(([rel]) => !ALLOWED.has(rel))

  it("scans the lib directory", () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it("has no setInterval driving an async callback", () => {
    const offenders = files
      .filter(([, abs]) => {
        const src = code(abs)
        /*
         * Three shapes, because the first version caught only one.
         *
         * It required the arrow body to be a bare call -- `() => void fn()` or
         * `async () => fn()` -- so `setInterval(async () => { await work() }, ms)`
         * passed. That is the most natural way to write the bug, and a negative
         * control that ADDED it to a lib file left the suite green. A guard that
         * passes against the thing it bans is worse than no guard, which is the
         * whole of R16.
         */
        return (
          // any async callback at all
          /setInterval\(\s*async\b/.test(src) ||
          // `() => void fn()` / `() => fn()`
          /setInterval\(\s*\(\s*\)\s*=>\s*(void\s+)?\w+\(/.test(src) ||
          // a block body that awaits
          /setInterval\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,400}?\bawait\b/.test(src)
        )
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it("reschedules the three sweepers even when a pass throws", () => {
    /*
     * The property that matters more than overlap. A sweeper that stops is
     * invisible: occupancy climbs for ever, and the mood panel reads "the event
     * was quiet".
     *
     * Asserted structurally rather than by proximity. A first draft checked that
     * a `setTimeout` appeared somewhere after a `catch`, and passed against a
     * version that rescheduled INSIDE the try — where a throw skips it and the
     * loop dies silently, which is the whole failure. The reschedule must be
     * somewhere a throw cannot skip, so what has to be true is the negative:
     * **no `setTimeout` inside the `try` block.**
     */
    for (const rel of [
      "lib/chat-lifecycle.ts",
      "lib/presence-sweeper.ts",
      "lib/sentiment-sweeper.ts",
    ]) {
      const src = code(join(ROOT, rel))
      const tryAt = src.indexOf("try {")
      expect(tryAt).toBeGreaterThan(-1)

      // Brace-match the try block rather than scanning to the next `}` — the
      // body contains nested braces, and a character class would stop at the
      // first one.
      let depth = 1
      let i = tryAt + "try {".length
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}") depth--
      }
      const tryBody = src.slice(tryAt, i)

      expect(tryBody).not.toContain("setTimeout(")
      // And it does reschedule, somewhere outside it.
      expect(src.slice(i)).toContain("setTimeout(")
    }
  })
})
