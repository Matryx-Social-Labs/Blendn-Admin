import { readFileSync } from "fs"
import { join } from "path"

/**
 * The venue-day sweeper runs (PL-G04, step 4 review).
 *
 * Expiry, the event-start close and the venue-day fence pass are all
 * `sweepVenueDays`, and the thirty-second expiry loop is `expireWindows`. A
 * sweeper nothing starts is the failure this project keeps having — a
 * capability built, typechecked, unit-tested and called by nobody — and here it
 * would leave every Go Live window open until its venue's day ended. Deleting
 * either call leaves every other test green, so this reads the source.
 *
 * Reads source, so it is registered in negative-controls.json.
 */
const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const sweeper = code("lib/presence-sweeper.ts")
const start = sweeper.slice(sweeper.indexOf("export function startPresenceSweeper"), sweeper.indexOf("export function stopPresenceSweeper"))

describe("startPresenceSweeper", () => {
  it("is started by the server, through the background work", () => {
    expect(code("server.ts")).toMatch(/\bstartBackgroundWork\(\)/)
    const background = code("lib/background.ts")
    const startWork = background.slice(background.indexOf("export function startBackgroundWork"))
    expect(startWork.slice(0, startWork.indexOf("\n}"))).toMatch(/\bstartPresenceSweeper\(\)/)
  })

  it("runs the venue-day pass in its own try, after the events pass", () => {
    const events = start.indexOf("await sweepPresence()")
    const days = start.indexOf("await sweepVenueDays()")
    expect(events).toBeGreaterThan(-1)
    expect(days).toBeGreaterThan(events)
    // A `try {` opens between them: one pass throwing cannot skip the other.
    expect(start.slice(events, days)).toMatch(/\}\s*(?:catch\s*\([^)]*\)\s*\{[\s\S]*?\}\s*)?(?:finally\s*\{[\s\S]*?\}\s*)?try\s*\{\s*$/)
  })

  it("runs the expiry pass on its own, shorter loop", () => {
    expect(start).toMatch(/await expireWindows\(\)/)
    expect(start).toMatch(/setTimeout\(expire, EXPIRY_INTERVAL_MS\)/)
    expect(sweeper).toMatch(/EXPIRY_INTERVAL_MS = 30_000/)
  })

  it("stops both loops", () => {
    const stop = sweeper.slice(sweeper.indexOf("export function stopPresenceSweeper"))
    expect(stop).toMatch(/clearTimeout\(timer\)/)
    expect(stop).toMatch(/clearTimeout\(expiryTimer\)/)
  })
})
