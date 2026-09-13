import { mutedRefusal } from "@/lib/moderation/actions"
import { readFileSync } from "fs"
import { join } from "path"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/socket-server", () => ({ emitChatMessageHidden: jest.fn(), emitChatMemberMuted: jest.fn() }))

/**
 * A mute says who muted you.
 *
 * Driven from the dashboard: an organiser pressed Mute, and both send routes
 * told the phone "Your messages have been flagged for policy violations" —
 * a person with zero flags, muted by a human, accused of breaking a rule.
 */
const read = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

describe("mutedRefusal", () => {
  it("names the organiser when a human applied the mute", () => {
    expect(mutedRefusal({ muted_by: "org_1" })).toBe("The organiser has muted you in this room.")
  })

  it("names the pipeline when nobody did", () => {
    expect(mutedRefusal({ muted_by: null })).toContain("flagged for policy violations")
  })

  it("is the copy both send routes use, so they cannot drift apart again", () => {
    for (const f of [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/events/[eventId]/chat/route.ts",
    ]) {
      const src = read(f)
      expect(src).toContain("mutedRefusal(membership)")
      expect(src).not.toContain("flagged for policy violations")
    }
  })

  it("leaves an audit row for every member action from the dashboard", () => {
    const src = read("app/api/events/[id]/chat/members/[userId]/route.ts")
    expect(src).toMatch(/auditLog\(\{[\s\S]*action: `chat\.member_\$\{action\}`/)
  })
})
