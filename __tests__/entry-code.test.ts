/**
 * The event's door code (gate 13, SCRUM-1316; spec: design/02a SPEC.md §1-§2).
 *
 * Identifiers say "entry code" so a grep never meets the ticket's door code
 * (`lib/tickets.ts`). Literals, never the constants under test.
 */
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "unit-nextauth-secret-0123456789abcdefghij"

jest.mock("@/lib/db", () => ({ db: {} }))

import { createHmac, hkdfSync } from "crypto"

import {
  currentEntryCode,
  entryCode,
  entryCodeOpen,
  entryPauseInForce,
  foldConfusables,
  matchEntryCode,
  tripsEntryPause,
} from "@/lib/entry-code"
import { passCode } from "@/lib/offers/pass-code"
import { codeStep } from "@/lib/rotating-code"

const EVENT = "7d1c0b6e-0000-4000-8000-000000000001"
const OTHER_EVENT = "7d1c0b6e-0000-4000-8000-000000000002"
const DAY1 = "9a000000-0000-4000-8000-000000000001"
const DAY2 = "9a000000-0000-4000-8000-000000000002"
const now = new Date("2026-11-29T17:00:10Z")
const step = Math.floor(now.getTime() / 30_000)
const MIN = 60_000

describe("the event's door code", () => {
  it("is six pass characters, keyed by its own label, turning every 30 seconds", () => {
    const { code, rotatesAt } = currentEntryCode(EVENT, DAY1, now)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(rotatesAt).toBe("2026-11-29T17:00:30.000Z")
    // HKDF("blendn door-code v1"), subject `${eventId}:${occurrenceId}:${step}` — never the offer pass's key.
    const key = Buffer.from(hkdfSync("sha256", process.env.NEXTAUTH_SECRET!, Buffer.alloc(0), "blendn door-code v1", 32))
    const mac = createHmac("sha256", key).update(`${EVENT}:${DAY1}:${step}`).digest()
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    expect(code).toBe([...mac.subarray(0, 6)].map((b) => alphabet[b & 31]).join(""))
    expect(code).not.toBe(passCode(`${EVENT}:${DAY1}`, step))
    expect(codeStep(now)).toBe(step)
  })

  it("matches the current step and the two before it", () => {
    for (const back of [0, 1, 2]) expect(matchEntryCode(EVENT, DAY1, entryCode(EVENT, DAY1, step - back), now)).toBe("match")
  })

  it("says a code from three steps back just changed, and anything older is wrong", () => {
    expect(matchEntryCode(EVENT, DAY1, entryCode(EVENT, DAY1, step - 3), now)).toBe("changed")
    expect(matchEntryCode(EVENT, DAY1, entryCode(EVENT, DAY1, step - 4), now)).toBe("wrong")
    expect(matchEntryCode(EVENT, DAY1, entryCode(EVENT, DAY1, step + 1), now)).toBe("wrong")
  })

  it("never admits another event's or another occurrence's code", () => {
    expect(matchEntryCode(EVENT, DAY1, entryCode(OTHER_EVENT, DAY1, step), now)).toBe("wrong")
    expect(matchEntryCode(EVENT, DAY2, entryCode(EVENT, DAY1, step), now)).toBe("wrong")
  })

  it("reads lower case, spaces and dashes, and folds 8/B, 5/S, 2/Z both ways", () => {
    expect(foldConfusables("B8S5Z2")).toBe("BBSSZZ")
    // Find a step whose code carries a folded letter, so the test is not vacuous.
    let s = step
    while (!/[BSZ825]/.test(entryCode(EVENT, DAY1, s))) s -= 1
    const at = new Date((s + 1) * 30_000 - 1)
    const code = entryCode(EVENT, DAY1, s)
    const misread = code.replace(/[BSZ825]/g, (c) => ({ B: "8", S: "5", Z: "2", "8": "B", "5": "S", "2": "Z" })[c]!)
    expect(misread).not.toBe(code)
    expect(matchEntryCode(EVENT, DAY1, misread, at)).toBe("match")
    expect(matchEntryCode(EVENT, DAY1, ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `, at)).toBe("match")
  })

  it("answers wrong to a code that cannot be one", () => {
    expect(matchEntryCode(EVENT, DAY1, "A1B2C3", now)).toBe("wrong")
    expect(matchEntryCode(EVENT, DAY1, "", now)).toBe("wrong")
    expect(matchEntryCode(EVENT, DAY1, "ABCDEFG", now)).toBe("wrong")
  })
})

describe("when the door code exists", () => {
  const start = new Date("2026-11-29T18:00:00Z")
  const day = { id: DAY1, occursOn: start, startTime: start, endTime: new Date("2026-11-29T21:00:00Z"), capacity: null, cancelledAt: null }
  const live = { status: "published" as const, kind: "event" as const, door_code_paused_at: null }

  it("from doors (start − 90 min) to the end, on a published event's open day", () => {
    expect(entryCodeOpen(live, [day], new Date("2026-11-29T16:30:00Z"))?.id).toBe(DAY1)
    expect(entryCodeOpen(live, [day], new Date("2026-11-29T16:29:00Z"))).toBeNull()
    expect(entryCodeOpen(live, [day], new Date("2026-11-29T21:01:00Z"))).toBeNull()
  })

  it("never on a draft, a venue day, a cancelled day, or while paused", () => {
    const at = new Date("2026-11-29T19:00:00Z")
    expect(entryCodeOpen({ ...live, status: "draft" }, [day], at)).toBeNull()
    expect(entryCodeOpen({ ...live, kind: "venue_day" }, [day], at)).toBeNull()
    expect(entryCodeOpen(live, [{ ...day, cancelledAt: at }], at)).toBeNull()
    expect(entryCodeOpen({ ...live, door_code_paused_at: new Date(at.getTime() - 2 * MIN) }, [day], at)).toBeNull()
  })
})

describe("the pause", () => {
  const occurrence = { startTime: new Date("2026-11-29T18:00:00Z") }
  const at = new Date("2026-11-29T19:00:00Z")

  it("is in force for ten minutes, then lifts itself", () => {
    expect(entryPauseInForce(new Date(at.getTime() - 9 * MIN), occurrence, at)).toBe(true)
    expect(entryPauseInForce(new Date(at.getTime() - 10 * MIN - 1), occurrence, at)).toBe(false)
    expect(entryPauseInForce(null, occurrence, at)).toBe(false)
  })

  it("does not count from before this occurrence's doors (last Friday's pause)", () => {
    const sixMinBeforeDoors = new Date("2026-11-29T16:24:00Z")
    expect(entryPauseInForce(sixMinBeforeDoors, occurrence, new Date("2026-11-29T16:31:00Z"))).toBe(false)
  })

  it("trips only when wrong ≥ 30 and wrong > correct", () => {
    expect(tripsEntryPause(29, 0)).toBe(false)
    expect(tripsEntryPause(30, 0)).toBe(true)
    expect(tripsEntryPause(30, 30)).toBe(false)
    expect(tripsEntryPause(31, 30)).toBe(true)
    expect(tripsEntryPause(60, 90)).toBe(false)
  })
})
