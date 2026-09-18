import { readFileSync } from "fs"
import { join } from "path"

/*
 * The Members tab said "Muted <when they joined>".
 *
 * `chat_group_members.updated_at` has `@default(now())` and no `@updatedAt`,
 * so it is the row's creation time and nothing ever moves it. The mute route
 * writes `muted_at`; the dashboard payload read `updated_at`. Driven on
 * staging for SCRUM-154: muted at 12:21, label said 12:12 — the check-in.
 */
const route = readFileSync(
  join(__dirname, "..", "app", "api", "events", "[id]", "chat", "messages", "route.ts"),
  "utf8"
)

describe("the Members tab's mutedAt", () => {
  it("reads muted_at, the column the mute writes", () => {
    expect(route).toMatch(/mutedAt:\s*m\.muted_at/)
    expect(route).not.toMatch(/mutedAt:[^\n]*updated_at/)
  })
})
