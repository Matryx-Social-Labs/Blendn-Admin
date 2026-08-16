import { readFileSync } from "fs"
import { join } from "path"
import { chatClosesAt, mayWriteToRoom } from "@/lib/chat-window"

/**
 * Who may write in an event's anonymous room.
 *
 * The rule is **attendance, not presence**: a `chat_group_members` row means you
 * were physically at the event, GPS-validated, and leaving does not unsee what
 * you saw. Presence — `event_check_ins.status`, `left_area_at` — keeps the
 * roster, the grid, occupancy and the app's "Live now" rail, and is never a
 * censor.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")

const ENDS = new Date("2026-08-16T22:00:00Z")
const EVENT = { end_time: ENDS }
const OPEN_GROUP = { status: "active" as const }
const MEMBER = { status: "active" }

const at = (hoursFromEnd: number) =>
  new Date(ENDS.getTime() + hoursFromEnd * 60 * 60 * 1000)

describe("the assertion that would have caught the bug", () => {
  it("lets someone who left before the end post after it", () => {
    /*
     * THE test. `lib/chat-window.ts` says the window exists to "catch people
     * while they are still outside the venue with an opinion" — and check-out
     * set `last_allowed_at = now`, so leaving the venue revoked the write access
     * the window was built to grant. The 24-hour room had never once worked for
     * the audience it was designed for.
     *
     * Checked out an hour before the end; posting an hour after it.
     */
    expect(mayWriteToRoom(MEMBER, EVENT, OPEN_GROUP, at(1))).toBeNull()
  })

  it("does not read last_allowed_at at all", () => {
    /*
     * A departure is not a forfeit. If this column ever comes back into the
     * write path, the bug comes back with it — so the absence is asserted, not
     * merely true today.
     */
    const src = read("lib", "chat-window.ts")
    const fn = src.slice(src.indexOf("export function mayWriteToRoom"))
    expect(fn).not.toContain("last_allowed_at")
    expect(fn).not.toContain("check_out_time")
    expect(fn).not.toContain("checked_in")
  })
})

describe("every scenario, as agreed", () => {
  const cases: Array<[string, Date, boolean]> = [
    ["present, event running", at(-2), true],
    ["stepped out 20 minutes, event running", at(-2), true],
    ["left early, event running", at(-1), true],
    ["left early, ended, within 24h", at(1), true],
    ["stayed to the end, within 24h", at(6), true],
    ["at the last minute of the window", at(23.9), true],
    ["past end_time + 24h", at(25), false],
  ]

  it.each(cases)("%s → %s", (_label, now, allowed) => {
    const denial = mayWriteToRoom(MEMBER, EVENT, OPEN_GROUP, now)
    expect(denial === null).toBe(allowed)
  })

  it("closes exactly at the documented 24 hours, not approximately", () => {
    const closes = chatClosesAt(EVENT)
    expect(mayWriteToRoom(MEMBER, EVENT, OPEN_GROUP, new Date(closes.getTime() - 1))).toBeNull()
    expect(mayWriteToRoom(MEMBER, EVENT, OPEN_GROUP, closes)).toEqual({ reason: "window_closed" })
  })
})

describe("the rules that still bite", () => {
  it("refuses a banned member even while the room is open", () => {
    expect(mayWriteToRoom({ status: "banned" }, EVENT, OPEN_GROUP, at(-1))).toEqual({
      reason: "banned",
    })
  })

  it("refuses a muted member", () => {
    expect(mayWriteToRoom({ status: "muted" }, EVENT, OPEN_GROUP, at(-1))).toEqual({
      reason: "muted",
    })
  })

  it("refuses a locked room, and says so distinctly", () => {
    // The organiser closed it deliberately; that is not the same message as a
    // window that ran out, and the composer shows different copy for each.
    expect(mayWriteToRoom(MEMBER, EVENT, { status: "locked" }, at(-1))).toEqual({
      reason: "locked",
    })
  })

  it("refuses an archived room", () => {
    expect(mayWriteToRoom(MEMBER, EVENT, { status: "archived" }, at(-1))).toEqual({
      reason: "archived",
    })
  })

  it("puts standing before the clock", () => {
    // A banned member past the window should read as banned, not as "the room
    // closed" — the second invites them to come back tomorrow.
    expect(mayWriteToRoom({ status: "banned" }, EVENT, OPEN_GROUP, at(30))).toEqual({
      reason: "banned",
    })
  })
})

describe("one rule, and it cannot fork again", () => {
  it("is called by both write paths", () => {
    /*
     * `chat-window.ts` records what happened last time this lived in two places:
     * one path rejected anything not `active`, the other only `locked`, so an
     * archived room stayed writable and a membership row from months ago was
     * still a licence to write.
     */
    for (const f of [
      ["app", "api", "mobile", "chat", "groups", "[chatGroupId]", "messages", "route.ts"],
      ["app", "api", "mobile", "events", "[eventId]", "chat", "route.ts"],
    ]) {
      expect(read(...f)).toContain("mayWriteToRoom")
    }
  })

  it("leaves no path still gating on the check-out cutoff", () => {
    /*
     * The old gates, gone. Writing `last_allowed_at: null` when a member joins
     * is fine — that is setting the column, not deciding anything from it. What
     * must never come back is a *branch* on it.
     */
    for (const f of [
      ["app", "api", "mobile", "chat", "groups", "[chatGroupId]", "messages", "route.ts"],
      ["app", "api", "mobile", "events", "[eventId]", "chat", "route.ts"],
    ]) {
      const src = read(...f)
      const branches = src.match(/^\s*(if|while).*last_allowed_at/gm) || []
      expect(branches).toEqual([])
    }
  })

  it("does not truncate readable history at check-out either", () => {
    /*
     * The read side had the same bug and it compounded: history was clamped to
     * `created_at <= last_allowed_at`, so someone who checked out could not read
     * what was said after they left — including the entire 24-hour window. The
     * room reopened, people talked, and everyone it was for saw nothing.
     */
    const src = read("app", "api", "mobile", "events", "[eventId]", "chat", "route.ts")
    expect(src).not.toContain("where.created_at = { lte: membershipFresh.last_allowed_at }")
  })
})
