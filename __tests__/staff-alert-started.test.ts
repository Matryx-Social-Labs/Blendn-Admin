import { readFileSync } from "fs"
import { join } from "path"

/** The staff alert (SCRUM-1161) only helps if the process starts it, and stops it on shutdown. */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8")
const bg = read("lib/background.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

describe("the staff alert sweeper", () => {
  it("is started with the other background work, and stopped with it", () => {
    expect(bg).toMatch(/startStaffAlertSweeper\(\)/)
    expect(bg).toMatch(/stopStaffAlertSweeper\(\)/)
  })

  it("is named in the start-up log, which lists every loop", () => {
    expect(read("lib/background.ts")).toMatch(/"staff-alert"/)
  })
})
