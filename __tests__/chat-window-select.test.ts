import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Every caller of `chatWindowState` must SELECT the columns it reads.
 *
 * This test exists because the pre-event floor shipped broken on one of two
 * write paths and nothing caught it.
 *
 * `lib/chat-window.ts` decides whether a room is open, and since #262 it reads
 * BOTH `start_time` (the pre-event floor: the room opens early for people who
 * RSVP'd) and `end_time`. `app/api/mobile/events/[eventId]/chat/route.ts`
 * called it from four places. Two selected `{ start_time: true, end_time: true }`.
 * Two selected `{ end_time: true }` alone.
 *
 * On those two paths `start_time` arrived as `undefined`, the floor evaluated
 * against nothing, and the same room gave opposite answers about whether chat
 * was open depending on which endpoint you asked. The commit message for
 * #262 asserts "Both write paths were updated to select it so neither is
 * un-floored by accident." One was.
 *
 * Why nothing caught it:
 *
 *   - `tsc` cannot see it. Prisma types a missing scalar as optional on the
 *     result, so `event.start_time` is legally `undefined` and the predicate
 *     accepts it.
 *   - `__tests__/room-write-access.test.ts` cannot see it. It tests
 *     `chatWindowState` as a pure function with both fields supplied, which is
 *     exactly the input the broken call sites never produce.
 *   - No integration test invokes that route handler.
 *
 * So the rule is enforced structurally, on the source text.
 *
 * Scoped to the shape that actually feeds the predicate. Both real call sites
 * pass `chatGroup.event`, so the input is always loaded as a nested relation:
 *
 *     include: { event: { select: { start_time: true, end_time: true } } }
 *
 * A bare `db.events.findUnique({ select: { title, end_time } })` in the same
 * file is a different query for a different purpose (naming a new chat group)
 * and is deliberately NOT matched. The first draft of this test flagged it,
 * which is how the scope got fixed rather than the innocent select.
 */

const ROOT = join(__dirname, "..")
const SEARCH_DIRS = ["app", "lib"]

/** Every `.ts`/`.tsx` file under the given directories. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * `event: { select: { ... } }` — the nested-relation shape `chatWindowState`
 * is fed from. Matched across newlines, since these are written inline.
 */
const EVENT_SELECT_BLOCK = /event:\s*\{\s*select:\s*\{[^{}]*\}/g

describe("chat-window callers select what the predicate reads", () => {
  const callers = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).filter((f) => {
    const src = readFileSync(f, "utf8")
    return src.includes("chatWindowState") && !f.endsWith("lib/chat-window.ts")
  })

  it("finds the call sites at all, so a rename cannot silently empty this test", () => {
    expect(callers.length).toBeGreaterThan(0)
  })

  it.each(callers.map((f) => [f.replace(`${ROOT}/`, ""), f]))(
    "%s selects start_time wherever it selects end_time on the event relation",
    (_label, file) => {
      const src = readFileSync(file as string, "utf8")
      const blocks = src.match(EVENT_SELECT_BLOCK) ?? []
      expect(blocks.length).toBeGreaterThan(0)
      const offenders = blocks.filter(
        (block) => block.includes("end_time") && !block.includes("start_time")
      )
      expect(offenders).toEqual([])
    }
  )
})
