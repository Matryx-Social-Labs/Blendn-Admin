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
      { signed_up: BigInt(125), onboarded: BigInt(78), rsvpd: BigInt(11), checked_in: BigInt(7), matched: BigInt(0), conversed: BigInt(0), returned: BigInt(3) },
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
