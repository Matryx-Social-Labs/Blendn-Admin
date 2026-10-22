import { readFileSync, readdirSync, statSync } from "fs"
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


/** Every .ts/.tsx under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/**
 * A file that reads `board_requests` by `to_user_id` (the author's side of an ask)
 * must either spread the shared filter, or say why it need not: it decides the
 * silence itself (`silenced_at`), or carries a `// board-visibility:` / `// asker-only:`
 * comment. A scan, not a list, so a NEW reader is caught too.
 */
const AWARE = /\b(VISIBLE_TO_AUTHOR|visibleBoardRequests|silenced_at)\b|\/\/ (board-visibility|asker-only):/

function authorSideReaders(): { file: string; src: string }[] {
  const ROOT = join(__dirname, "..")
  return [...sources(join(ROOT, "app")), ...sources(join(ROOT, "lib"))]
    .map((f) => ({ file: f.slice(ROOT.length + 1), src: readFileSync(f, "utf8") }))
    .filter(({ src }) => /\bboard_requests\b/.test(src) && /\bto_user_id\b/.test(src))
    // An import is not use: only the body counts.
    .map(({ file, src }) => ({ file, src: src.replace(/^import[\s\S]*?from ".*"\n/gm, "") }))
}

describe("every author-facing read of board asks uses the shared filter (a scan)", () => {
  it("rejects a source that does not (the control)", () => {
    expect(AWARE.test("db.board_requests.findMany({ where: { to_user_id: me } })")).toBe(false)
    expect(AWARE.test("db.board_requests.findMany({ where: { to_user_id: me, ...VISIBLE_TO_AUTHOR } })")).toBe(true)
    expect(AWARE.test("// asker-only: the asker's own row\ndb.board_requests.findMany({ where: { to_user_id: me } })")).toBe(true)
  })

  it("finds the readers at all (a scan that matched nothing would pass vacuously)", () => {
    expect(authorSideReaders().map((r) => r.file)).toEqual(
      expect.arrayContaining(["app/api/mobile/board/requests/route.ts", "lib/board-access.ts", "lib/notification-display.ts"])
    )
  })

  it("has every one of them aware of silenced asks", () => {
    expect(authorSideReaders().filter((r) => !AWARE.test(r.src)).map((r) => r.file)).toEqual([])
  })

  it("has no bare count of a post's requests on the board list", () => {
    expect(read("app/api/mobile/events/[eventId]/board/route.ts")).not.toMatch(/requests:\s*true/)
    expect(read("app/api/mobile/events/[eventId]/board/route.ts")).toMatch(/visibleBoardRequests/)
  })

  it("keeps the shared constants where the readers import them from", () => {
    const access = read("lib/board-access.ts")
    expect(access).toMatch(/export const VISIBLE_TO_AUTHOR = \{ silenced_at: null \}/)
    expect(access).toMatch(/export const visibleBoardRequests = /)
  })
})
