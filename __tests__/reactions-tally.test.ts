import { readFileSync } from "fs"
import { join } from "path"

import { tallyReactions } from "@/lib/reactions"

/**
 * Reactions are a count, never a roster.
 *
 * `docs/CHAT.md:119` is unambiguous: *"reactions show the count only, never who
 * — who reacted is exactly the kind of thing this room does not disclose."*
 * Both read paths shipped `userId` and `userName` for every reaction on every
 * message, and the client honoured the rule by choosing not to draw them.
 *
 * That is the weakest form a privacy guarantee can take. The disclosure was in
 * the response, one screen away from a client that happened not to render it,
 * and one `JSON.stringify` from anyone who looked — including any future screen
 * written by somebody who reasonably assumed a field in the payload was there
 * to be used.
 *
 * The fold is unit-tested here because it is pure and the interesting cases are
 * cheap to state; the structural half asserts neither route can go back to
 * emitting an identity.
 */
const ROOT = join(__dirname, "..")

const ME = "viewer-1"
const r = (emoji: string, user_id: string) => ({ emoji, user_id })

describe("tallyReactions", () => {
  it("counts per emoji rather than listing people", () => {
    const out = tallyReactions([r("🔥", "a"), r("🔥", "b"), r("👏", "c")], ME)

    expect(out).toEqual([
      { emoji: "🔥", count: 2, mine: false },
      { emoji: "👏", count: 1, mine: false },
    ])
  })

  it("tells the viewer which ones are theirs, and only theirs", () => {
    const out = tallyReactions([r("🔥", ME), r("🔥", "b"), r("👏", "c")], ME)

    expect(out).toEqual([
      { emoji: "🔥", count: 2, mine: true },
      { emoji: "👏", count: 1, mine: false },
    ])
  })

  it("is empty for no reactions", () => {
    expect(tallyReactions([], ME)).toEqual([])
  })

  it("orders deterministically, so one message does not reshuffle between reads", () => {
    /*
     * A Map iterates in insertion order, which here is row order — so without a
     * sort the same message renders its reactions in whatever sequence Postgres
     * returned, and the order changes between requests for no reason the user
     * can see.
     */
    const a = tallyReactions([r("👏", "x"), r("🔥", "y"), r("🔥", "z")], ME)
    const b = tallyReactions([r("🔥", "z"), r("👏", "x"), r("🔥", "y")], ME)

    expect(a).toEqual(b)
    expect(a.map((t) => t.emoji)).toEqual(["🔥", "👏"])
  })

  it("breaks ties by emoji, not by arrival", () => {
    const out = tallyReactions([r("🔥", "a"), r("👏", "b")], ME)
    expect(out.map((t) => t.emoji)).toEqual(out.map((t) => t.emoji).sort())
  })
})

/**
 * Does this source emit an identity inside a reaction payload?
 *
 * Extracted so it can be run against known-bad input. The scan lives on a
 * regex, and a regex that stops matching reports that a rule holds while
 * checking nothing — the tree is expected to be clean, so "found no offenders"
 * is the pass condition and a broken detector is indistinguishable from
 * success. A recorded control blinding the pattern left this file green.
 */
function emitsReactorIdentity(src: string): boolean {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  for (const m of clean.matchAll(/reactions:\s*/g)) {
    const rest = clean.slice(m.index! + m[0].length, m.index! + m[0].length + 400)
    /*
     * A `userId:` **key**, not the identifier. Matching the bare word also
     * flagged `tallyReactions(m.reactions, authUser.userId)` — the viewer's own
     * id, which is what `mine` is computed from and the one identity this
     * payload is allowed to know.
     *
     * Third narrowing this needed, and each was the same mistake: a rule about
     * what is *emitted*, written as a search for a string that also appears in
     * what is *read*.
     */
    if (/\buserId\s*:|\buserName\s*:/.test(rest.split("\n").slice(0, 6).join("\n"))) {
      return true
    }
  }
  return false
}

describe("neither read path can name a reactor again", () => {
  const routes = [
    "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
    "app/api/mobile/events/[eventId]/chat/route.ts",
  ]

  it("finds the routes and their reaction handling", () => {
    // The control: both assertions below are absences, and an absence is also
    // what a wrong path produces.
    for (const rel of routes) {
      const src = readFileSync(join(ROOT, rel), "utf8")
      expect({ rel, tallied: src.includes("tallyReactions(") }).toEqual({ rel, tallied: true })
    }
  })

  it("detects an identity when one is there", () => {
    // The counter, against known-bad input — because a clean tree and a broken
    // detector produce the same result.
    expect(
      emitsReactorIdentity(`reactions: m.reactions.map((r) => ({ emoji: r.emoji, userId: r.user_id }))`)
    ).toBe(true)
    expect(
      emitsReactorIdentity(`reactions: rows.map((r) => ({ emoji: r.emoji, userName: nameFor(r) }))`)
    ).toBe(true)

    // And that it is not simply saying yes to everything.
    expect(emitsReactorIdentity(`reactions: tallyReactions(m.reactions, authUser.userId)`)).toBe(false)
    expect(emitsReactorIdentity(`reactions: { select: { emoji: true, user_id: true } }`)).toBe(false)
  })

  it("emits no identity from either route", () => {
    const offenders = routes
      .filter((rel) => emitsReactorIdentity(readFileSync(join(ROOT, rel), "utf8")))
      .map((rel) => `${rel}: a reaction payload emits an identity`)

    expect({
      offenders,
      hint: offenders.length
        ? "docs/CHAT.md:119 — reactions show the count only, never who. `mine` is the " +
          "viewer's own fact about themselves and is the only disclosure allowed."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })
})
