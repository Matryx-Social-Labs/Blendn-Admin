import { readFileSync } from "fs"
import { join } from "path"
import { eventSession, pickOccurrence, type OccurrenceSlot } from "@/lib/occurrences"
import { closedDoorMessage } from "@/lib/checkin-messages"

/**
 * A multi-day event, as the app shows it and as the door judges it.
 *
 * Staging, 2026-09-28 23:05 IST, `blr-design-festival`: three days of
 * 00:45–08:45 IST, the third cancelled. Day 2 had ended hours before. The app
 * said "Happening now", LIVE and offered "Blend in", because it judged the
 * event by `start_time`/`end_time` — the whole run, which had a day left. The
 * door judged by occurrence and refused, and said "Event has not started yet"
 * about a festival two days in, because the next day it found was the
 * cancelled one.
 *
 * These are those exact rows.
 */

const TZ = "Asia/Kolkata"
const at = (iso: string) => new Date(iso)

const slot = (id: string, start: string, end: string, cancelled = false): OccurrenceSlot => ({
  id,
  occursOn: at(start),
  startTime: at(start),
  endTime: at(end),
  capacity: null,
  cancelledAt: cancelled ? at("2026-09-27T15:13:45Z") : null,
})

const FESTIVAL = [
  slot("day1", "2026-09-26T19:15:00Z", "2026-09-27T03:15:00Z"),
  slot("day2", "2026-09-27T19:15:00Z", "2026-09-28T03:15:00Z"),
  slot("day3", "2026-09-28T19:15:00Z", "2026-09-29T03:15:00Z", true),
]

const asEvent = (slots: OccurrenceSlot[]) => ({
  start_time: slots[0].startTime,
  end_time: slots[slots.length - 1].endTime,
  occurrences: slots.map((s) => ({ start_time: s.startTime, end_time: s.endTime, cancelled_at: s.cancelledAt })),
})

describe("the evening after day 2, with day 3 cancelled (the staging report)", () => {
  const now = at("2026-09-28T17:35:00Z") // 23:05 IST

  it("the app's window is day 2, which has ended — not the run, which has not", () => {
    const session = eventSession(asEvent(FESTIVAL), now)
    expect(session).toEqual({ startTime: FESTIVAL[1].startTime, endTime: FESTIVAL[1].endTime })
    expect(session!.endTime.getTime()).toBeLessThan(now.getTime())
    // What the app read before: still running.
    expect(asEvent(FESTIVAL).end_time.getTime()).toBeGreaterThan(now.getTime())
  })

  it("the door does not call the cancelled day 3 'not started'", () => {
    const verdict = pickOccurrence(FESTIVAL, now)
    expect(verdict).toMatchObject({ ok: false, reason: "cancelled", occurrence: { id: "day3" } })
  })

  it("and says the event is over, as EVENT_ENDED", () => {
    const verdict = pickOccurrence(FESTIVAL, now)
    if (verdict.ok) throw new Error("expected a refusal")
    expect(closedDoorMessage(verdict.reason, verdict.occurrence, FESTIVAL, TZ, now)).toEqual({
      message: "Day 3 of 3 has been cancelled, so the event is over.",
      ended: true,
    })
  })

  it("inside day 3's own hours too", () => {
    const later = at("2026-09-28T21:00:00Z")
    const verdict = pickOccurrence(FESTIVAL, later)
    expect(verdict).toMatchObject({ ok: false, reason: "cancelled", occurrence: { id: "day3" } })
    expect(eventSession(asEvent(FESTIVAL), later)!.endTime).toEqual(FESTIVAL[1].endTime)
  })
})

describe("the rest of a multi-day run", () => {
  it("during day 2: live, and the door is open", () => {
    const now = at("2026-09-27T22:00:00Z")
    expect(eventSession(asEvent(FESTIVAL), now)!.startTime).toEqual(FESTIVAL[1].startTime)
    expect(pickOccurrence(FESTIVAL, now)).toMatchObject({ ok: true, occurrence: { id: "day2" } })
  })

  it("between days: the window is the next day, and the refusal names it", () => {
    const now = at("2026-09-27T10:00:00Z") // 15:30 IST, day 1 over
    const session = eventSession(asEvent(FESTIVAL), now)!
    expect(session.startTime).toEqual(FESTIVAL[1].startTime)
    expect(session.startTime.getTime()).toBeGreaterThan(now.getTime())

    const verdict = pickOccurrence(FESTIVAL, now)
    if (verdict.ok) throw new Error("expected a refusal")
    expect(verdict).toMatchObject({ reason: "too_early", occurrence: { id: "day2" } })
    expect(closedDoorMessage(verdict.reason, verdict.occurrence, FESTIVAL, TZ, now)).toEqual({
      message: "Day 2 starts Mon, Sep 28, 12:45 AM.",
      ended: false,
    })
  })

  it("a cancelled middle day is skipped for the next one", () => {
    const run = [FESTIVAL[0], { ...FESTIVAL[1], cancelledAt: at("2026-09-27T00:00:00Z") }, { ...FESTIVAL[2], cancelledAt: null }]
    const now = at("2026-09-27T22:00:00Z") // inside day 2's hours
    expect(eventSession(asEvent(run), now)!.startTime).toEqual(run[2].startTime)

    const verdict = pickOccurrence(run, now)
    if (verdict.ok) throw new Error("expected a refusal")
    expect(closedDoorMessage(verdict.reason, verdict.occurrence, run, TZ, now)).toEqual({
      message: "Day 2 has been cancelled. Day 3 starts Tue, Sep 29, 12:45 AM.",
      ended: false,
    })

    // Before day 2's doors, "too early" skips it to day 3 rather than naming it.
    const earlier = at("2026-09-27T10:00:00Z")
    expect(pickOccurrence(run, earlier)).toMatchObject({ reason: "too_early", occurrence: { id: "day3" } })
  })

  it("every day cancelled: no window at all", () => {
    const run = FESTIVAL.map((s) => ({ ...s, cancelledAt: at("2026-09-20T00:00:00Z") }))
    expect(eventSession(asEvent(run), at("2026-09-27T22:00:00Z"))).toBeNull()
  })
})

describe("single-day events are unchanged", () => {
  const night = [slot("only", "2026-09-28T15:30:00Z", "2026-09-28T21:30:00Z")]

  it("the window is the event's own", () => {
    expect(eventSession(asEvent(night), at("2026-09-28T16:00:00Z"))).toEqual({
      startTime: night[0].startTime,
      endTime: night[0].endTime,
    })
  })

  it("an event read without occurrences falls back to its own window", () => {
    const e = { start_time: night[0].startTime, end_time: night[0].endTime }
    expect(eventSession(e)).toEqual({ startTime: e.start_time, endTime: e.end_time })
  })

  it("keeps its old sentences", () => {
    const early = at("2026-09-28T10:00:00Z")
    const v = pickOccurrence(night, early)
    if (v.ok) throw new Error("expected a refusal")
    expect(closedDoorMessage(v.reason, v.occurrence, night, TZ, early)).toEqual({
      message: "Event has not started yet",
      ended: false,
    })
    const late = at("2026-09-29T10:00:00Z")
    const w = pickOccurrence(night, late)
    if (w.ok) throw new Error("expected a refusal")
    expect(closedDoorMessage(w.reason, w.occurrence, night, TZ, late)).toEqual({
      message: "Event has already ended",
      ended: true,
    })
  })
})

describe("every payload the app judges 'live' by carries the session", () => {
  const ROOT = join(__dirname, "..")
  const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

  it.each([
    "lib/services/events.service.ts",
    "app/api/mobile/events/[eventId]/route.ts",
    "app/api/mobile/me/rsvps/route.ts",
  ])("%s", (file) => {
    const code = src(file)
    expect(code).toContain("session: eventSession(event)")
    expect(code).toContain("occurrences: sessionOccurrencesSelect")
  })

  it("the door's refusal copy comes from closedDoorMessage", () => {
    expect(src("app/api/mobile/events/[eventId]/checkin/route.ts")).toContain("closedDoorMessage(")
  })

  it("rating waits for the same window, not the run", () => {
    expect(src("app/api/mobile/events/[eventId]/rating/route.ts")).toContain("eventSession(event)")
  })
})
