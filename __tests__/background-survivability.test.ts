import { readFileSync } from "fs"
import { join } from "path"

/**
 * Work that ran only because something else happened to be running.
 *
 * All three failures here are silent. A loop that never starts, a loop that
 * overlaps itself, and a count that reports what it selected rather than what
 * it changed — none logs an error, and the visible symptom in each case reads
 * as an ordinary quiet night.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("I8 — the sweepers are not a side effect of Socket.io", () => {
  it("starts them from server.ts, deliberately", () => {
    /*
     * Four loops started inside `initSocketServer`, coupled to a decision they
     * have nothing to do with — none emits over a socket. Serve the app any way
     * that does not attach a websocket server and all of them stop with **no
     * log line**: the presence sweeper stopping means nobody is ever checked
     * out, so occupancy climbs for ever and `over_capacity` latches as a
     * permanent critical alert.
     */
    const server = code("server.ts")
    expect(server).toMatch(/startBackgroundWork\(\)/)
    expect(server).toMatch(/stopBackgroundWork\(\)/)
  })

  it("does not start them inside initSocketServer", () => {
    const socket = code("lib/socket-server.ts")
    expect(socket).not.toMatch(/startPresenceSweeper\(\)/)
    expect(socket).not.toMatch(/startSentimentSweeper\(\)/)
    expect(socket).not.toMatch(/startChatLifecycleSweeper\(\)/)
  })

  it("keeps the sponsored scheduler with Socket.io, because it needs io", () => {
    // Not everything moves. This one emits into chat rooms.
    //
    // Pinned on `startSponsoredScheduler`, not `sponsoredMessageScheduler
    // .loadAll()`. #264 extracted the scheduler into its own module and renamed
    // the entry point while #276 was moving the other loops out; neither branch
    // could see the other, so only the merged tree fails on the old name. The
    // invariant is unchanged -- this loop stays coupled to `io` on purpose.
    expect(code("lib/socket-server.ts")).toMatch(/startSponsoredScheduler\(/)
  })

  it("uses relative imports, because server.ts compiles with plain tsc", () => {
    // `build:server` emits the @/ alias verbatim into the require().
    const bg = readFileSync(join(ROOT, "lib/background.ts"), "utf8")
    expect(bg).not.toMatch(/from "@\//)
  })

  it("stops every loop it starts", () => {
    /*
     * Each holds a live timer, so a missed stop keeps the event loop alive and
     * the process waits out the forced-exit timeout — which is exactly how the
     * ops broadcast came to be the fifth timer nobody was stopping.
     */
    const bg = code("lib/background.ts")
    const started = [...bg.matchAll(/start(\w+Sweeper)\(\)/g)].map((m) => m[1])
    const stopped = [...bg.matchAll(/stop(\w+Sweeper)\(\)/g)].map((m) => m[1])
    expect(started.length).toBeGreaterThan(0)
    expect(new Set(stopped)).toEqual(new Set(started))
  })
})

describe("I9 — the ops loop cannot stack on itself", () => {
  const src = code("lib/socket-server.ts")

  it("schedules the next pass from the end of the current one", () => {
    /*
     * This was the one loop using `setInterval` with an async body. The two
     * sweepers both self-schedule and both carry a comment saying a slow pass
     * must not overlap the next — and it matters more here: `buildLiveSnapshot`
     * issues around ten round trips every five seconds per watched event, on
     * the Socket.io event loop, so overlapping passes make the database slower,
     * which makes the next pass longer.
     */
    expect(src).toMatch(/state\.timer = setTimeout\(\(\) => void tick\(\), OPS_INTERVAL_MS\)/)
    expect(src).not.toMatch(/setInterval\(\(\) => \{\s*void \(async/)
  })

  it("stops an in-flight pass from scheduling a successor", () => {
    /*
     * The other half of the guard. `stopOpsBroadcast` can fire while a pass is
     * awaiting, and clearing the timer alone would let that pass arm a new one
     * after the loop was supposed to be gone.
     */
    expect(src).toMatch(/if \(stopped\) return/)
    expect(src).toMatch(/loop\.stop\(\)/)
    expect(src).toMatch(/if \(loop\.timer\) clearTimeout\(loop\.timer\)/)
  })
})

describe("I14 — the archive sweep reports what it changed", () => {
  const src = code("lib/chat-lifecycle.ts")

  it("filters both writes on the state they are leaving", () => {
    /*
     * The docstring says "both writes are `updateMany` filtered on the state
     * they are leaving". One was filtered on the id alone, so two replicas
     * selecting the same batch would both write it and both report having
     * archived it.
     */
    expect(src).toMatch(/where: \{ id: \{ in: ids \}, status: "active" \}/)
  })

  it("counts rooms changed, not rooms selected", () => {
    expect(src).toMatch(/archived: archived\.count/)
    expect(src).not.toMatch(/archived: ids\.length/)
  })
})
