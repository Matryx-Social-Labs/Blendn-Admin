import { readFileSync, readdirSync, statSync } from "fs"
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
  // The night's people (SV6, #728).
  "lib/night-people.ts",
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

/**
 * The other half, as a SCAN so a surface nobody listed is caught too: reading a
 * person's friends with `friendIdsOf` (the friendships alone) from anywhere but the
 * friend code and the crews (whose membership REQUIRES a friendship) misses the
 * 24 h of an ended friendship that `notStrangersTo` carries. A people surface calls
 * `notStrangersTo`; a deliberate friends-only read says `// friends-only: why`.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe("no people surface reads friends without the 24 h of an ended friendship", () => {
  const ALLOWED = /^(lib\/friends\.ts|lib\/room-people\.ts|lib\/crews\/|app\/api\/mobile\/friends\/)/
  const offenders = () =>
    [...sources(join(ROOT, "app")), ...sources(join(ROOT, "lib"))]
      .map((f) => ({ file: f.slice(ROOT.length + 1), src: readFileSync(f, "utf8") }))
      .filter(({ file, src }) => !ALLOWED.test(file) && /\bfriendIdsOf\(/.test(src) && !/\/\/ friends-only:/.test(src))
      .map((r) => r.file)

  it("finds the crews' reads, so the scan matches something", () => {
    const crew = readFileSync(join(ROOT, "lib/crews/crews.ts"), "utf8")
    expect(/\bfriendIdsOf\(/.test(crew)).toBe(true)
  })

  it("lists no file outside the friend code and the crews that calls friendIdsOf", () => {
    expect(offenders()).toEqual([])
  })
})
