import { readFileSync } from "fs"
import { join } from "path"

/**
 * Every socket handler registers on connect, none inside another handler.
 *
 * `join:eventOps` and `leave:eventOps` were written inside the body of the
 * `leave:event` callback -- one missing brace. They therefore did not exist
 * until a client emitted `leave:event`, and `lib/use-ops-snapshot.ts` emits
 * `join:eventOps` on connect and never emits `leave:event` at all. So the live
 * operations room accepted nobody, `ops:snapshot` never fired, and the screen
 * sat empty. Every `leave:event` would also have stacked another duplicate
 * pair of listeners.
 *
 * Nothing caught it: it compiles, it lints, and the socket tests exercise the
 * `canJoin*` predicates rather than whether anything is wired to them. The
 * authorisation was never wrong -- the handler holding it was unreachable,
 * which is the more embarrassing failure and the harder one to see in a diff.
 *
 * Indentation is a proxy for nesting, and a coarse one. It is chosen because
 * the alternative -- standing up an http server, a real Socket.io instance and
 * a connected client to assert `listenerCount` -- is a large harness for one
 * brace, and this fails on exactly the mistake that was made.
 */

const SOURCE = join(process.cwd(), "lib", "socket-server.ts")

describe("socket handlers are registered at connection level", () => {
  const lines = readFileSync(SOURCE, "utf8").split("\n")

  const registrations = lines
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => /^\s*authSocket\.on\(/.test(line))
    .map(({ line, lineNo }) => ({
      lineNo,
      event: line.match(/authSocket\.on\("([^"]+)"/)?.[1] ?? "?",
      indent: line.match(/^ */)![0].length,
    }))

  it("finds the handlers at all", () => {
    // Without this the assertion below passes vacuously if the file moves.
    expect(registrations.length).toBeGreaterThan(10)
  })

  it("registers the ops room handlers", () => {
    // The two that were unreachable. Named explicitly because their absence is
    // what broke the live dashboard.
    const events = registrations.map((r) => r.event)
    expect(events).toContain("join:eventOps")
    expect(events).toContain("leave:eventOps")
  })

  it("nests none of them inside another handler", () => {
    const baseline = Math.min(...registrations.map((r) => r.indent))
    const nested = registrations
      .filter((r) => r.indent > baseline)
      .map((r) => `${r.event} (line ${r.lineNo}, indent ${r.indent})`)

    // Listed rather than counted so a failure names the handler that moved.
    expect(nested).toEqual([])
  })
})
