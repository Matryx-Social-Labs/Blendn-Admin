jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))

import { roomReadDenial } from "@/lib/chat-window"
import { bannedRefusal } from "@/lib/moderation/actions"

/*
 * Who may read a room (SCRUM-205). One rule for the socket join and every
 * HTTP read; the integration test drives it through the three routes.
 */
const published = { status: "published" }

it.each([
  ["active", null],
  ["muted", null], // a mute silences, it does not banish (SCRUM-178)
  ["left", null], // every member of an archived room; the transcript is theirs
  ["banned", "banned"],
] as const)("a %s member → %s", (status, expected) => {
  expect(roomReadDenial({ status }, published)).toBe(expected)
})

it("refuses somebody with no membership row", () => {
  expect(roomReadDenial(null, published)).toBe("not_member")
  expect(roomReadDenial(undefined, published)).toBe("not_member")
})

it("hides a draft event's room even from an active member", () => {
  expect(roomReadDenial({ status: "active" }, { status: "draft" })).toBe("hidden")
})

it("says who removed them", () => {
  expect(bannedRefusal({ banned_by: "user_organiser" })).toBe("The organiser has removed you from this room.")
  expect(bannedRefusal({ banned_by: null })).toMatch(/after repeated policy violations/)
})
