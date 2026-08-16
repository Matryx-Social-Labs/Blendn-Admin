import { readFileSync } from "fs"
import { join } from "path"
import {
  chatClosedMessage,
  chatClosesAt,
  chatWindowState,
  entitlementAdmits,
  mayWriteToRoom,
  roomEntitlement,
} from "@/lib/chat-window"

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
    /*
     * Bounded to the function, where it used to run to the end of the file.
     *
     * That was fine while `mayWriteToRoom` was last in the module and became
     * wrong the moment `roomEntitlement` was added below it — which legitimately
     * *does* mention `checked_in`, because who may **join** a room and whether a
     * member may **write** right now are different questions with different
     * answers. Presence decides the first and must never decide the second.
     *
     * The rule this protects is unchanged; only the slice is honest about which
     * function it is reading.
     */
    const start = src.indexOf("export function mayWriteToRoom")
    const fn = src.slice(start, src.indexOf("\n}", start) + 2)
    expect(fn).toContain("membership.status")
    expect(fn).not.toContain("last_allowed_at")
    expect(fn).not.toContain("check_out_time")
    expect(fn).not.toContain("checked_in")
  })

  it("keeps joining and writing as separate questions", () => {
    /*
     * The distinction the bug above was a violation of. `roomEntitlement` is
     * allowed to read presence — being at the venue is the strongest claim on a
     * room — and `mayWriteToRoom` is not, because a claim on the room is not the
     * same as permission to speak in it *now*.
     */
    const src = read("lib", "chat-window.ts")
    expect(src.indexOf("export function roomEntitlement")).toBeGreaterThan(
      src.indexOf("export function mayWriteToRoom")
    )
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

describe("the room has a floor now, not only a ceiling", () => {
  const STARTS = new Date("2026-08-16T18:00:00Z")
  const TIMED = { start_time: STARTS, end_time: ENDS }
  const before = (hours: number) =>
    new Date(STARTS.getTime() - hours * 60 * 60 * 1000)

  it("is shut two days before the event", () => {
    /*
     * The point of the floor. Without it, RSVPing to a festival three months
     * out is a licence to sit in its chatroom for three months — and a room
     * with no event around it is a public channel that happens to be named
     * after a date.
     */
    expect(chatWindowState(TIMED, OPEN_GROUP, before(48)).open).toBe(false)
  })

  it("says when rather than just no", () => {
    const state = chatWindowState(TIMED, OPEN_GROUP, before(48))
    expect(state.open).toBe(false)
    if (!state.open) {
      expect(state.reason).toBe("not_open_yet")
      // "Closed" for a room that has never opened reads as a fault, and the
      // person asking is somebody who RSVP'd and is keen.
      expect(chatClosedMessage(state.reason)).toContain("opens")
    }
  })

  it("opens 24 hours before the start", () => {
    expect(chatWindowState(TIMED, OPEN_GROUP, before(23)).open).toBe(true)
  })

  it("is open during the event, as it always was", () => {
    expect(chatWindowState(TIMED, OPEN_GROUP, at(-1)).open).toBe(true)
  })

  it("still closes 24 hours after the end", () => {
    expect(chatWindowState(TIMED, OPEN_GROUP, at(25)).open).toBe(false)
  })

  it("treats a missing start as no floor at all", () => {
    /*
     * Several callers select only `end_time`. A silent tightening there would
     * close rooms that used to open, and read as the chat being broken rather
     * than as a rule — so the absence of a start means the absence of a floor.
     */
    expect(chatWindowState({ end_time: ENDS }, OPEN_GROUP, before(48)).open).toBe(true)
  })
})

describe("who has a claim on the room", () => {
  const OPEN = { open: true } as const
  const SHUT = { open: false, reason: "not_open_yet" } as const

  it("ranks being there above having said you would be", () => {
    // The roster and the audit trail should record the strongest claim, not
    // whichever query happened to run first.
    expect(roomEntitlement({ checkedIn: true, rsvpGoing: true, interested: true }))
      .toBe("checked_in")
    expect(roomEntitlement({ checkedIn: false, rsvpGoing: true, interested: true }))
      .toBe("rsvp")
    expect(roomEntitlement({ checkedIn: false, rsvpGoing: false, interested: true }))
      .toBe("interested")
    expect(roomEntitlement({ checkedIn: false, rsvpGoing: false, interested: false }))
      .toBeNull()
  })

  it("admits somebody standing in the venue whatever the clock says", () => {
    /*
     * Checking in is proof you are there, so it needs no calendar argument —
     * and it must not get one, or somebody inside an event that started early
     * would be refused their own room.
     */
    expect(entitlementAdmits("checked_in", SHUT)).toBe(true)
  })

  it("makes the weaker claims good only inside the window", () => {
    expect(entitlementAdmits("rsvp", OPEN)).toBe(true)
    expect(entitlementAdmits("rsvp", SHUT)).toBe(false)
    expect(entitlementAdmits("interested", OPEN)).toBe(true)
    expect(entitlementAdmits("interested", SHUT)).toBe(false)
  })

  it("admits nobody with no claim, even inside the window", () => {
    expect(entitlementAdmits(null, OPEN)).toBe(false)
  })
})
