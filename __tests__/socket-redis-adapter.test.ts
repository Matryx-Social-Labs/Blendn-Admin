import { readFileSync } from "fs"
import { join } from "path"

/**
 * The Redis adapter's request timeout (perf/chat-path). Its default is 5 s: with
 * two or more replicas one slow replica holds every `fetchSockets` up to that
 * long, and a timeout rejects the call, dropping that socket delivery.
 */
describe("the socket server's Redis adapter", () => {
  it("is created with a 1 s request timeout, not the 5 s default", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "socket-server.ts"), "utf8")
    expect(src).toMatch(/createAdapter\(pubClient, subClient, \{ requestsTimeout: 1000 \}\)/)
  })
})
