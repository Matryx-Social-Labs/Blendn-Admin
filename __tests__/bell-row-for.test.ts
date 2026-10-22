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

// Rewritten for a build before Flow 9. `event_cancelled` joins this list when it exists (#724); until then it is not a kind.
const DOWNGRADED = ["event_changed"]

describe("bellRowFor(row, null)", () => {
  it("reads the kinds from the schema", () => {
    expect(KINDS).toEqual(expect.arrayContaining(["event_changed", "announcement", "friend_request"]))
  })

  it.each(KINDS.filter((k) => !DOWNGRADED.includes(k)))("returns the same object for %s", (kind) => {
    const row = { id: "r", kind, data: { type: kind, eventId: "e1" } }
    expect(bellRowFor(row, null)).toBe(row)
  })

  it("rewrites event_changed for a build that does not declare Flow 9, and only then", () => {
    const row = { id: "r", kind: "event_changed", data: { type: "event_changed", eventId: "e1", reason: "time" } }
    expect(bellRowFor(row, null)).not.toBe(row)
    expect(bellRowFor(row, null)).toMatchObject({ kind: "event_update", data: { type: "event_update", eventId: "e1" } })
    expect(bellRowFor(row, 2)).toBe(row)
  })
})
