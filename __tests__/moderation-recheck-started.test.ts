import { readFileSync } from "fs"
import { join } from "path"

/** The re-check sweep (moderation-degraded policy) only helps if the process starts it, and stops it on shutdown. */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8")
const bg = read("lib/background.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

describe("the moderation re-check sweeper", () => {
  it("is started with the other background work, and stopped with it", () => {
    expect(bg).toMatch(/startModerationRecheckSweeper\(\)/)
    expect(bg).toMatch(/stopModerationRecheckSweeper\(\)/)
  })

  it("is named in the start-up log, which lists every loop", () => {
    expect(read("lib/background.ts")).toMatch(/"moderation-recheck"/)
  })

  it("imports by relative path, with everything it reaches that is its own, because server.ts compiles with plain tsc", () => {
    for (const file of ["lib/moderation-recheck.ts", "lib/moderation/text-breaker.ts", "lib/moderation/actions.ts"]) {
      expect(read(file)).not.toMatch(/from "@\//)
    }
  })
})
