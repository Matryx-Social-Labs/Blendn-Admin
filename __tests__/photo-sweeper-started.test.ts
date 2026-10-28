import { readFileSync } from "fs"
import { join } from "path"

/** The unchecked-photo sweep (SCRUM-732) only helps if the process starts it, and stops it on shutdown. */
const bg = readFileSync(join(__dirname, "..", "lib/background.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

describe("the photo moderation sweeper", () => {
  it("is started with the other background work, and stopped with it", () => {
    expect(bg).toMatch(/startPhotoModerationSweeper\(\)/)
    expect(bg).toMatch(/stopPhotoModerationSweeper\(\)/)
  })

  it("starts and stops the orphan photo sweeper too (SCRUM-730)", () => {
    expect(bg).toMatch(/startOrphanPhotoSweeper\(\)/)
    expect(bg).toMatch(/stopOrphanPhotoSweeper\(\)/)
  })

  it("is imported by a relative path, because server.ts compiles with plain tsc", () => {
    for (const file of ["lib/photo-sweeper.ts", "lib/photo-orphans.ts"]) {
      expect(readFileSync(join(__dirname, "..", file), "utf8")).not.toMatch(/from "@\//)
    }
  })
})
