import { readFileSync } from "fs"
import { join } from "path"

/**
 * A silenced ask (`board_requests.silenced_at`: the pair already had a link) does
 * not exist for its author: no list, no count, no badge. Every author-facing read
 * of `board_requests` spreads the one shared filter (`VISIBLE_TO_AUTHOR`, or
 * `visibleBoardRequests` for a count), so a new reader cannot forget it — the
 * count on the board list did, and a post's `requestCount` going up with nothing
 * to show for it named the linked pair. The failure names the file.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8")
const FILTER = /\b(VISIBLE_TO_AUTHOR|visibleBoardRequests)\b/

const AUTHOR_FACING = [
  "app/api/mobile/events/[eventId]/board/route.ts",
  "app/api/mobile/board/requests/route.ts",
]

describe("every author-facing read of board asks uses the shared filter", () => {
  it("rejects a source that does not (the control)", () => {
    expect(FILTER.test("_count: { select: { requests: true } }")).toBe(false)
    expect(FILTER.test("_count: { select: { requests: { where: visibleBoardRequests(me) } } }")).toBe(true)
  })

  it("has the board list and the requests list use it, and no bare count of a post's requests", () => {
    expect(AUTHOR_FACING.filter((f) => !FILTER.test(read(f)))).toEqual([])
    expect(read("app/api/mobile/events/[eventId]/board/route.ts")).not.toMatch(/requests:\s*true/)
  })

  it("keeps the shared constant where the readers import it from", () => {
    const access = read("lib/board-access.ts")
    expect(access).toMatch(/export const VISIBLE_TO_AUTHOR = \{ silenced_at: null \}/)
    expect(access).toMatch(/export const visibleBoardRequests = /)
  })
})
