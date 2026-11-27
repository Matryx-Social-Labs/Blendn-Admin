process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "unit-nextauth-secret-0123456789abcdefghij"
jest.mock("@/lib/db", () => ({ db: {} }))

import { placeOfRef } from "@/lib/report-evidence"
import { roomHandle } from "@/lib/room-handle"

/* Where a person report was filed from, read off the handle it named them by (SCRUM-1176). */
const U = "user-1"
const G = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b"

it("reads the place a handle was minted in", () => {
  expect(placeOfRef(roomHandle(G, U))).toEqual({ eventId: G })
  for (const kind of ["crew", "blend", "board_post"] as const) {
    expect(placeOfRef(roomHandle({ kind, groupId: G }, U))).toEqual({ chatGroupId: G })
  }
  expect(placeOfRef(roomHandle({ kind: "dm", groupId: G }, U))).toEqual({ conversationId: G })
})

it("reads no place from a raw id or a forged handle", () => {
  expect(placeOfRef(G)).toBeNull()
  expect(placeOfRef("rh_" + "A".repeat(60))).toBeNull()
})
