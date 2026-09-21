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
  expect(src).toMatch(/signed out and will need the new password/)
  expect(src).toMatch(/setDone\(\{ revokedSessions: result\.revokedSessions \?\? 0 \}\)/)
  // What the change does not touch is still stated: other dashboard sessions.
  expect(src).toMatch(/Other dashboard sessions stay signed in/)
})
