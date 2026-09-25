import { readFileSync } from "fs"
import { join } from "path"
import { neverPublished } from "@/lib/dashboard-format"

/*
 * "Never published" is the acquisition number, so it counts live accounts only
 * (SCRUM-310): on staging 5 of the 9 it counted were suspended.
 */
it("counts accounts that shipped nothing, leaving out the suspended", () => {
  expect(
    neverPublished([
      { published: 0, suspended: false },
      { published: 0, suspended: true },
      { published: 3, suspended: false },
      { published: 2, suspended: true },
    ])
  ).toBe(1)
})

it("the host table says a suspended row is suspended, ahead of its last event", () => {
  const src = readFileSync(join(__dirname, "..", "components", "role-users-table.tsx"), "utf8")
  expect(src).toMatch(/user\.suspended \? \(\s*<span[^>]*>Suspended<\/span>/)
})
