import { readFileSync } from "fs"
import { join } from "path"

/**
 * Friends never meet as strangers in a room (the owner's rule, 2026-10-22,
 * plans/friends-in-room.md). Every surface that lists, ranks, pairs or counts
 * strangers asks `lib/room-people.ts` (`notStrangersTo`, `knownToEachOther`,
 * `strangersApartBetween`). A new people surface that forgets is the bug this
 * stops; the failure names the file.
 *
 * The control: a source that does NOT reference the helper is rejected, so the
 * scan cannot pass vacuously (recorded in negative-controls.json).
 */
const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const REFERENCES = /\b(notStrangersTo|knownToEachOther|strangersApartBetween)\b/

export const PEOPLE_SURFACES = [
  "lib/matches.ts",
  "app/api/mobile/events/[eventId]/checkins/route.ts",
  "lib/room-preview.ts",
  "app/api/mobile/chat/groups/[chatGroupId]/participants/route.ts",
  "lib/socket-server.ts",
  "app/api/mobile/events/[eventId]/matches/likes/route.ts",
  "app/api/mobile/events/[eventId]/waves/route.ts",
  "app/api/mobile/message-requests/route.ts",
  // B3
  "lib/crews/presence.ts",
  "lib/crews/like.ts",
  "app/api/mobile/events/[eventId]/board/route.ts",
  "app/api/mobile/events/[eventId]/board/[postId]/requests/route.ts",
  "lib/board-access.ts",
  "lib/trust.ts",
]

describe("every people surface in a room asks lib/room-people.ts", () => {
  it("rejects a source that does not reference it (the control)", () => {
    expect(REFERENCES.test("const hidden = await blockCounterparties(me)")).toBe(false)
    expect(REFERENCES.test("const hidden = [...(await notStrangersTo(me))]")).toBe(true)
  })

  it("lists each surface it was written for, all of which still exist", () => {
    for (const file of PEOPLE_SURFACES) expect(read(file).length).toBeGreaterThan(0)
  })

  it("has every listed surface reference the helper", () => {
    const missing = PEOPLE_SURFACES.filter((file) => !REFERENCES.test(read(file)))
    expect(missing).toEqual([])
  })
})
