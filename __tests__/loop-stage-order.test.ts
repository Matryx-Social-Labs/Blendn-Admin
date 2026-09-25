import { readFileSync } from "fs"
import { join } from "path"

/*
 * "Came back" is attending a second event, so it follows "checked in" and the
 * hero reads it by name (SCRUM-313). It was the last stage, under `matched` and
 * `conversed`, and the hero read the last stage: three people who had come
 * back read as "Nobody has been back for a second event yet".
 */
jest.mock("@/lib/db", () => ({
  db: {
    $queryRaw: jest.fn().mockResolvedValue([
      { signed_up: 125n, onboarded: 78n, rsvpd: 11n, checked_in: 7n, matched: 0n, conversed: 0n, returned: 3n },
    ]),
  },
}))
import { loopClosure } from "@/lib/loop-closure"

it("puts came back after checked in, and gives matched its base", async () => {
  const stages = await loopClosure()
  expect(stages.map((s) => s.label)).toEqual(["signed up", "onboarded", "RSVP'd", "checked in", "came back", "matched", "conversed"])
  expect(stages.find((s) => s.label === "came back")?.value).toBe(3)
  expect(stages.find((s) => s.label === "matched")?.base).toBe("checked in")
})

it("the hero reads came back by name, not the last stage", () => {
  const src = readFileSync(join(__dirname, "..", "components", "dashboard", "overview-admin.tsx"), "utf8")
  expect(src).toMatch(/const metStage = data\.funnel\.find\(\(stage\) => stage\.label === "came back"\)/)
})
