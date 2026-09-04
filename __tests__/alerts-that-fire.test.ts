import { readFileSync } from "fs"
import { join } from "path"
import { lexiconFallback } from "@/lib/sentiment/lexicon"

/**
 * Four alerts on the screen an organiser watches during an event.
 *
 * Three could not fire at all and one could not stop. None of them errored, so
 * a quiet live tab was indistinguishable from a working one — which is the
 * failure mode that makes an ops screen worse than no ops screen, because
 * somebody is relying on it.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("I5 — entry_backing_up was mathematically disabled", () => {
  it("takes the baseline over slots that had an arrival", () => {
    /*
     * The median was taken over EVERY completed ten-minute slot since doors,
     * densified with zeros. Arrivals cluster hard at the start, so most slots
     * of an evening are zero, so the median is zero — and `deriveAlerts` guards
     * on `medianRate10m > 0`.
     *
     * The comment claimed dropping the zeros would make the alert "progressively
     * harder to fire". It was the zeros that made it impossible, and they got
     * more effective as the night went on.
     */
    const src = code("lib/live-snapshot.ts")
    expect(src).toMatch(/const busyBuckets = arrivalBuckets/)
    expect(src).toMatch(/\.filter\(\(n\) => n > 0\)/)
    // The dense-series loop is gone, not merely unused.
    expect(src).not.toMatch(/arrivalsByBucket\.get\(slot\) \?\? 0/)
  })

  it("needs three busy slots before there is a baseline at all", () => {
    /*
     * With one or two, the baseline IS the opening rush, and every event would
     * trip on its own second bucket. Silence for the first half hour is the
     * correct answer — a queue at doors is expected.
     */
    const src = code("lib/live-snapshot.ts")
    expect(src).toMatch(/MIN_BUCKETS_FOR_BASELINE = 3/)
    expect(src).toMatch(/busyBuckets\.length >= MIN_BUCKETS_FOR_BASELINE \? busyBuckets : \[\]/)
  })
})

describe("I6 — leaving_early fired permanently from day two", () => {
  it("scopes the check-in counts to the occurrence", () => {
    /*
     * `checkedInTotal` and `checkedOutTotal` were event-wide, so on the morning
     * of day two every day-one row was already `checked_out` — a ratio of ~1.0
     * against a threshold of 0.25, at doors, on every multi-day event. An alert
     * that is always on is an alert nobody reads, and it sits beside the safety
     * one.
     */
    const src = code("lib/live-snapshot.ts")
    expect(src).toMatch(/const slot = await resolveOccurrence\(eventId, now\)/)

    /*
     * The scoping moved rather than went away. The four `...today` spreads are
     * gone because the four counts are gone: `headcount` answers all of them
     * in one query and takes the scope as an argument, so an unscoped read is
     * no longer something you can write by omission — it is a different call.
     *
     * That is a stronger guarantee than the spread was, and the invariant is
     * unchanged: the live counts are the resolved occurrence's, falling back
     * to event-wide only when no occurrence resolves.
     */
    expect(src).toMatch(
      /headcount\(slot\.occurrence \? \{ occurrenceId: slot\.occurrence\.id \} : \{ eventId \}/
    )
    // And no count slipped back in beside it, unscoped.
    expect(src).not.toMatch(/db\.event_check_ins\.count\(/)
  })
})

describe("I13 — the live tab and the occupancy panel disagreed", () => {
  it("measures against the occurrence's capacity", () => {
    /*
     * This read `event.max_capacity` while `getOccupancy` resolved a
     * per-occurrence one — the exact "two screens, one room, two answers" the
     * comment beside it says the shared module prevents. It prevented the
     * arithmetic diverging, not the input.
     */
    const src = code("lib/live-snapshot.ts")
    expect(src).toMatch(/capacity: slot\.occurrence\?\.capacity \?\? event\.max_capacity/)
  })
})

describe("I7 — the safety alert was wired to a value nothing produced", () => {
  it("keeps a recognised safety report when the model is unavailable", () => {
    /*
     * `classifyWithLexicon` returns null for a safety cue ON PURPOSE, to force
     * a real read. The degraded path then wrote a hardcoded `neutral / other`,
     * so the detection was computed and discarded — and `deriveAlerts` fires on
     * `category === "safety_conduct"`, which nothing ever wrote without an API
     * key. `lib/env.ts` marks that key optional.
     */
    const result = lexiconFallback("someone is harassing people near the bar")
    expect(result.category).toBe("safety_conduct")
    expect(result.sentiment).toBe("negative")
    // Visibly uncertain, and below what a matched lexicon rule claims.
    expect(result.confidence).toBeLessThan(0.7)
  })

  it("does not invent a polarity for ordinary chatter", () => {
    /*
     * This path is reached because the polarity was ambiguous, negated or
     * absent. Guessing one would flatten the mood bar with noise, which is the
     * opposite failure.
     */
    const result = lexiconFallback("does anyone know where the cloakroom is")
    expect(result.sentiment).toBe("neutral")
  })

  it("never returns null, so a message cannot vanish from the digest", () => {
    expect(lexiconFallback("")).not.toBeNull()
    expect(lexiconFallback("").category).toBe("other")
  })

  it("is what the degraded branch actually calls", () => {
    const src = code("lib/sentiment/classify.ts")
    expect(src).toMatch(/settled\.push\(\{ id: message\.id, \.\.\.lexiconFallback\(message\.text\) \}\)/)
    expect(src).not.toMatch(/confidence: 0\.2/)
  })
})
