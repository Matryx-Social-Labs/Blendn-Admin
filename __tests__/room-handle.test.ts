process.env.NEXTAUTH_SECRET = "room-handle-test-secret-at-least-32-chars"

import { isRoomHandle, resolveUserRef, roomHandle, userIdFromRef } from "@/lib/room-handle"

/*
 * The per-event handle that stands in for another person's user id on every
 * room surface (SCRUM-371). Four properties carry the whole design, so each is
 * pinned: it goes back to the right person without a lookup, it is the same
 * every time for one room, it is unlinkable across rooms, and it cannot be
 * forged or bent into another person.
 */
const EVENT = "0b9f3c2e-6a41-4d6c-9a8e-2f1d7c5b4a30"
const OTHER_EVENT = "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const USER = "cmg1k2l3m0000ab12cd34ef56"

describe("roomHandle / resolveUserRef", () => {
  it("round-trips to the person and the room, without a lookup", () => {
    const handle = roomHandle(EVENT, USER)
    expect(handle.startsWith("rh_")).toBe(true)
    expect(resolveUserRef(handle)).toEqual({ userId: USER, eventId: EVENT })
    expect(userIdFromRef(handle)).toBe(USER)
  })

  it("is deterministic: the same pair is the same handle", () => {
    expect(roomHandle(EVENT, USER)).toBe(roomHandle(EVENT, USER))
    // Case in the uuid is not a different room.
    expect(roomHandle(EVENT.toUpperCase(), USER)).toBe(roomHandle(EVENT, USER))
  })

  it("is a different handle in a different room, and a different person in the same one", () => {
    expect(roomHandle(OTHER_EVENT, USER)).not.toBe(roomHandle(EVENT, USER))
    expect(roomHandle(EVENT, `${USER}x`)).not.toBe(roomHandle(EVENT, USER))
  })

  it("never carries the real id, or any recognisable piece of it", () => {
    const handle = roomHandle(EVENT, USER)
    expect(handle).not.toContain(USER)
    expect(handle).not.toContain(USER.slice(0, 8))
    expect(handle).not.toContain(Buffer.from(USER).toString("base64url").slice(0, 8))
  })

  it("is url-safe: it travels as a path segment", () => {
    expect(roomHandle(EVENT, USER)).toMatch(/^rh_[A-Za-z0-9_-]+$/)
  })

  it("answers null for a tampered, truncated or invented handle — never a different person", () => {
    const handle = roomHandle(EVENT, USER)
    const body = Buffer.from(handle.slice(3), "base64url")

    for (let i = 0; i < body.length; i++) {
      const flipped = Buffer.from(body)
      flipped[i] ^= 0x01
      expect(resolveUserRef(`rh_${flipped.toString("base64url")}`)).toBeNull()
    }
    expect(resolveUserRef(handle.slice(0, -2))).toBeNull()
    expect(resolveUserRef(`${handle}AA`)).toBeNull()
    expect(resolveUserRef("rh_")).toBeNull()
    expect(resolveUserRef("rh_!!not base64!!")).toBeNull()
    expect(resolveUserRef(`rh_${Buffer.alloc(80, 7).toString("base64url")}`)).toBeNull()
  })

  it("does not verify under another key", () => {
    const handle = roomHandle(EVENT, USER)
    const saved = process.env.NEXTAUTH_SECRET
    process.env.NEXTAUTH_SECRET = "a-completely-different-secret-of-32-chars"
    try {
      expect(resolveUserRef(handle)).toBeNull()
    } finally {
      process.env.NEXTAUTH_SECRET = saved
    }
    expect(resolveUserRef(handle)).toEqual({ userId: USER, eventId: EVENT })
  })

  it("passes a raw id through untouched, with no room", () => {
    expect(resolveUserRef(USER)).toEqual({ userId: USER, eventId: null })
    expect(userIdFromRef(USER)).toBe(USER)
    expect(isRoomHandle(USER)).toBe(false)
    expect(isRoomHandle(roomHandle(EVENT, USER))).toBe(true)
  })

  it("hands a route the ref itself when a handle does not verify, so it reads as an unknown id", () => {
    // No account id starts `rh_` (they are cuids), so every existing lookup
    // then misses exactly as it does for an id nobody has.
    expect(userIdFromRef("rh_forged")).toBe("rh_forged")
  })

  it("refuses a room that is not a uuid rather than inventing one", () => {
    expect(() => roomHandle("not-a-uuid", USER)).toThrow()
  })

  it("fails loudly without its key, like the pseudonyms", () => {
    const saved = process.env.NEXTAUTH_SECRET
    delete process.env.NEXTAUTH_SECRET
    try {
      expect(() => roomHandle(EVENT, USER)).toThrow("NEXTAUTH_SECRET is required")
    } finally {
      process.env.NEXTAUTH_SECRET = saved
    }
  })
})
