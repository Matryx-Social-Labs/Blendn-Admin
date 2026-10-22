import { readFileSync } from "fs"
import { join } from "path"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("expo-server-sdk", () => ({ Expo: class {} }))

import { bellRowFor } from "@/lib/push-notifications"

/**
 * `bellRowFor` rewrites exactly one kind for a build that does not know it.
 * Every other kind comes back as the SAME object, so a new kind added to the
 * enum is never downgraded, copied or reshaped by accident (#722 review).
 */
const KINDS = [...(/enum notification_kind \{([^}]*)\}/.exec(readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8"))?.[1] ?? "").matchAll(/^\s*([a-z_]+)\s*$/gm)].map((m) => m[1])

// The kinds a build before Flow 9 does not know, rewritten to `event_update` for it (#724 added event_cancelled).
const DOWNGRADED = ["event_changed", "event_cancelled"]

describe("bellRowFor(row, null)", () => {
  it("reads the kinds from the schema", () => {
    expect(KINDS).toEqual(expect.arrayContaining(["event_changed", "announcement", "friend_request"]))
  })

  it.each(KINDS.filter((k) => !DOWNGRADED.includes(k)))("returns the same object for %s", (kind) => {
    const row = { id: "r", kind, data: { type: kind, eventId: "e1" } }
    expect(bellRowFor(row, null)).toBe(row)
  })

  it.each(DOWNGRADED)("rewrites %s for a build that does not declare Flow 9, and only then", (kind) => {
    const row = { id: "r", kind, data: { type: kind, eventId: "e1", reason: "time" } }
    expect(bellRowFor(row, null)).not.toBe(row)
    expect(bellRowFor(row, null)).toMatchObject({ kind: "event_update", data: { type: "event_update", eventId: "e1" } })
    expect(bellRowFor(row, 2)).toBe(row)
  })
})
