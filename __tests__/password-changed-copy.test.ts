import { readFileSync } from "fs"
import { join } from "path"

/*
 * The sentence after a password change tells the truth about the phones
 * (SCRUM-169). Driven on staging: the action revoked both of Arjun's phone
 * sessions and the screen said "Your other sessions stay signed in".
 */
const src = readFileSync(join(__dirname, "..", "app", "dashboard", "settings", "settings-form.tsx"), "utf8")

it("does not claim the phones stayed signed in", () => {
  expect(src).not.toMatch(/Your other sessions stay signed in/)
  expect(src).toMatch(/phones were`\} signed out/)
  expect(src).toMatch(/setDone\(\{ revokedSessions: result\.revokedSessions \?\? 0 \}\)/)
})

/*
 * And about the dashboard (step 18 security review, M6): the change ends
 * every dashboard session now, this one included. The sentence used to say
 * the others stayed signed in, which was true, and an invitation to stop
 * there; it would now be false.
 */
it("says every dashboard session ended, this one included", () => {
  expect(src).not.toMatch(/Other dashboard sessions stay signed in/)
  expect(src).toMatch(/Every dashboard session has ended, this one included/)
})
