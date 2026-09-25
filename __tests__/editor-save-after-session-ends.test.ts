import { readFileSync } from "fs"
import { join } from "path"

/*
 * A save refused for a dead session says so (SCRUM-163).
 *
 * Driven on staging: sign out underneath the editor, press Save → PATCH 401 →
 * the toast said "Failed to save event", the one sentence it says for every
 * failure. The person retries a save that can never land. The 401 branch is a
 * few lines that a tidy-up would fold back into the generic throw; this is
 * the line that notices.
 */
const src = readFileSync(join(__dirname, "..", "components", "event-editor.tsx"), "utf8")

describe("the event editor's save", () => {
  it("tells a signed-out person to sign in again, and keeps their changes", () => {
    // The exact condition, so `&& false` or a second operand fails it too.
    const branch = src.indexOf("if (response.status === 401) {")
    expect(branch).toBeGreaterThan(-1)
    // Every other refusal is read AFTER the 401 branch, so a 401 never reaches it
    // (SCRUM-315 replaced the generic throw with the route's own sentence).
    expect(src.indexOf("if (!response.ok) {")).toBeGreaterThan(branch)
    expect(src.slice(branch, branch + 700)).toMatch(/Your session has ended[^"]*changes are still here/)
    // No navigation on 401 — navigating away is how the changes would be lost.
    expect(src.slice(branch, branch + 700)).not.toMatch(/router\.(push|replace)/)
  })
})
