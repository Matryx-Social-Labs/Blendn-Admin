jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))
import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"
import { blocksExclude } from "@/lib/crews/blocks"
import { crewMayMeetSolo } from "@/lib/crews/presence"
import { ownerRoomClosesAt } from "@/lib/room-kind"

/**
 * Crew matching's rules (CR-U04, CR-U06, §8.3) and its one writer (CR-G03).
 *
 * The rules are pure and pinned here. The writer rule is structural: every
 * like and every Blend goes through lib/crews/like.ts, which checks presence,
 * the guardrails and blocks across every member first — a like written from a
 * route would skip all three. And every writer of a block takes the pair out
 * of the Blends that now refuse them, or a socket that joined before would
 * keep two people who blocked each other in a room together.
 */

const ROOT = join(__dirname, "..")
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}
const SOURCES = ["app", "lib", "scripts"].flatMap((d) => sourceFiles(join(ROOT, d))).map((f) => ({
  file: relative(ROOT, f),
  src: strip(readFileSync(f, "utf8")),
}))

describe("blocks across any member exclude the sides (CR-U04)", () => {
  const blocked = new Set(["a2|b3", "b3|a2"])
  it("any pair, either direction, not only the person asking", () => {
    expect(blocksExclude(["a1", "a2"], ["b1", "b2", "b3"], blocked)).toBe(true)
    expect(blocksExclude(["b1", "b3"], ["a2"], blocked)).toBe(true)
  })
  it("no pair across the sides, no exclusion", () => {
    expect(blocksExclude(["a1"], ["b1", "b2"], blocked)).toBe(false)
    expect(blocksExclude([], ["b3"], blocked)).toBe(false)
  })
})

describe("who a crew may meet alone (§8.3)", () => {
  const crew = (open: boolean, intent: string[] = ["friendship"]) => ({ open_to_solo: open, intent })
  it("only with room for one more, and six or fewer", () => {
    expect(crewMayMeetSolo(crew(true), 6, ["friendship"])).toBe(true)
    expect(crewMayMeetSolo(crew(true), 7, ["friendship"])).toBe(false)
    expect(crewMayMeetSolo(crew(false), 3, ["friendship"])).toBe(false)
  })
  it("dating only when both chose it", () => {
    expect(crewMayMeetSolo(crew(true, ["dating"]), 3, ["friendship"])).toBe(false)
    expect(crewMayMeetSolo(crew(true, ["dating", "friendship"]), 3, ["networking"])).toBe(false)
    expect(crewMayMeetSolo(crew(true, ["dating"]), 3, ["dating"])).toBe(true)
    // A person out for dating meeting a crew that is not: not a romantic approach.
    expect(crewMayMeetSolo(crew(true, ["friendship"]), 3, ["dating"])).toBe(true)
  })
})

describe("a Blend closes twelve hours after its occurrence ends (CR-U06)", () => {
  it("the occurrence's end, not its start", () => {
    const occurrence = { start_time: new Date("2026-10-03T14:00:00Z"), end_time: new Date("2026-10-03T22:00:00Z") }
    expect(ownerRoomClosesAt(occurrence).toISOString()).toBe("2026-10-04T10:00:00.000Z")
  })
})

describe("one writer (CR-G03)", () => {
  const WRITE = (table: string) =>
    new RegExp(`\\b${table}\\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\\(|INSERT INTO "?${table}\\b|UPDATE "?${table}\\b`)

  it("finds the writer at all (the control)", () => {
    const like = SOURCES.find((s) => s.file === "lib/crews/like.ts")
    expect(like && WRITE("crew_likes").test(like.src)).toBe(true)
    expect(like && WRITE("blends").test(like.src)).toBe(true)
  })

  it("crew_likes and blends are created only by lib/crews/like.ts", () => {
    const CREATE = (table: string) => new RegExp(`\\b${table}\\.(?:create|createMany|upsert)\\(|INSERT INTO "?${table}\\b`)
    const elsewhere = SOURCES.filter((s) => s.file !== "lib/crews/like.ts")
      .filter((s) => CREATE("crew_likes").test(s.src) || CREATE("blends").test(s.src))
      .map((s) => s.file)
    expect(elsewhere).toEqual([])
  })

  it("and changed or removed only where it was decided: closing on the clock, a crew ending, the purge, the fixture clean-up", () => {
    const decided: Record<string, string> = {
      "lib/crews/like.ts": "the writer",
      "lib/crews/sweep.ts": "a dissolved or hidden crew's Blends closed; lapsed likes purged",
      "lib/chat-lifecycle.ts": "a Blend closed on its clock",
      "scripts/seed-room.ts": "--clean removes the fixture's rows",
    }
    const PURGE = /DELETE FROM "?(crew_likes|blends)\b/
    const writers = SOURCES.filter((s) => WRITE("crew_likes").test(s.src) || WRITE("blends").test(s.src) || PURGE.test(s.src)).map((s) => s.file)
    expect(writers.filter((f) => !(f in decided))).toEqual([])
    // The control: the decided writers are still found, so the list stays true.
    expect(writers.sort()).toEqual(Object.keys(decided).sort())
  })

  it("every writer of a block takes the pair out of the Blends that now refuse them", () => {
    const writers = SOURCES.filter((s) => /\bblocked_users\.(?:create|createMany|upsert)\(/.test(s.src))
    // The control: the writers this was written against are still found.
    expect(writers.map((w) => w.file).sort()).toEqual([
      "app/api/mobile/conversations/[conversationId]/leave/route.ts",
      "app/api/mobile/message-requests/[requestId]/respond/route.ts",
      "app/api/mobile/users/[userId]/block/route.ts",
    ])
    const silent = writers.filter((w) => !/\bevictBlockedFromBlends\(/.test(w.src)).map((w) => w.file)
    expect(silent).toEqual([])
  })

  it("asks the sides again for a block inside the transaction that writes the like (MUST)", () => {
    const like = SOURCES.find((s) => s.file === "lib/crews/like.ts")!.src
    const tx = like.slice(like.indexOf("db.$transaction(async (tx) =>"))
    const recheck = tx.indexOf("blocksBetween(sides.a, sides.b, tx)")
    expect(recheck).toBeGreaterThan(0)
    expect(recheck).toBeLessThan(tx.indexOf("crew_likes.createMany("))
  })
})
