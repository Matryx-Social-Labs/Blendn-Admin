/*
 * The Socket.io instance is shared through `globalThis`, not held in the module.
 *
 * Next.js bundles its own copy of `lib/socket-server.ts` into every route and
 * server-action chunk that imports it, while `server.ts` initialises a
 * different copy. A module-local `let io` therefore stayed null in the copy
 * every REST route used, and every `emit*` returned at its guard: a message
 * posted to a room never reached the phones in it. Found by joining a room
 * over a socket, posting through the route, and receiving nothing — in dev and
 * against the production build alike.
 */
import { readFileSync } from "fs"
import { join } from "path"

const src = readFileSync(join(process.cwd(), "lib/socket-server.ts"), "utf8")

describe("lib/socket-server.ts", () => {
  it("keeps the instance on globalThis rather than in a module-local", () => {
    expect(src).not.toMatch(/^let io\b/m)
    expect(src).toMatch(/__blendnSocketIo = io/)
  })

  it("every emitter reads the shared instance before its guard", () => {
    // Each `if (!io …)` guard must be preceded by `const io = currentIo()`;
    // a guard on a stale local would be the original bug in one function.
    const guards = [...src.matchAll(/^([ \t]+)if \(!io[ |)]/gm)]
    expect(guards.length).toBeGreaterThan(5)
    for (const g of guards) {
      const before = src.slice(0, g.index).split("\n").slice(-2).join("\n")
      expect(before).toContain("const io = currentIo()")
    }
  })
})
