import { discloseSocial, type LiveSocialCounts } from "@/lib/live-social"
import { forVenue, type LiveSnapshot } from "@/lib/live-metrics"
import { discloseGroup, MIN_CELL } from "@/lib/disclosure"

/**
 * The Live tab's "Meeting tonight" panel (Live A, SCRUM-1051): what a host is
 * told of how the room is meeting. Aggregates only, and every count of people
 * under five is "a few", never the number — a host who watches 3 turn into 4
 * learns who just did it.
 */

function counts(over: Partial<LiveSocialCounts> = {}): LiveSocialCounts {
  return {
    connections: { attendees: 44, connections: 15, connected: 23, reachedOut: 30, byWay: { waves: 9, lobby: 4, requests: 2 } },
    conversations: 12,
    lobby: { offer: 6, seeking: 3, chat: 0 },
    tonight: { asked: true, answered: 31 },
    crews: { here: 3, people: 9 },
    ...over,
  }
}

describe("discloseSocial", () => {
  it("gives the host the share who met someone, of how many, and the pairs by how they met", () => {
    const s = discloseSocial(counts())
    expect(s.attendees).toBe(44)
    // Two ways under five: the total is no longer exact, or 15 - 9 gives their sum back.
    expect(s.met).toEqual({ held: false, pct: 52, connected: 23, connections: { atLeast: 11 }, byWay: { waves: 9, lobby: "few", requests: "few" } })
    // The control: every way at five or more, so all of it is exact.
    const all = discloseSocial(counts({ connections: { attendees: 44, connections: 20, connected: 30, reachedOut: 30, byWay: { waves: 10, lobby: 5, requests: 5 } } }))
    expect(all.met).toMatchObject({ connections: 20, byWay: { waves: 10, lobby: 5, requests: 5 } })
  })

  it("holds every connection figure back under the pairs floor, and still shows the rest", () => {
    const s = discloseSocial(counts({ connections: { attendees: 7, connections: 2, connected: 4, reachedOut: 5, byWay: { waves: 2, lobby: 0, requests: 0 } } }))
    expect(s.met).toEqual({ held: true, floor: 8 })
    expect(s.conversations).toBe(12)
  })

  it("says a few for one to four, and zero as zero: an empty Lobby names nobody", () => {
    const s = discloseSocial(counts({ conversations: 4, lobby: { offer: 1, seeking: 0, chat: 5 } }))
    expect(s.conversations).toBe("few")
    expect(s.lobby).toEqual({ posts: { atLeast: 6 }, offer: "few", seeking: 0, chat: 5 })
    expect(discloseSocial(counts({ conversations: 0 })).conversations).toBe(0)
    expect(discloseSocial(counts({ conversations: 5 })).conversations).toBe(5)
  })

  it("says the Lobby total as at least the cells it can show, never exactly beside a hidden kind", () => {
    expect(discloseSocial(counts({ lobby: { offer: 1, seeking: 1, chat: 1 } })).lobby.posts).toEqual({ atLeast: 3 })
    expect(discloseSocial(counts({ lobby: { offer: 6, seeking: 5, chat: 0 } })).lobby.posts).toBe(11)
  })

  it("shows Tonight's answers as a count of the guests, a few, or nearly all when the rest are a few", () => {
    expect(discloseSocial(counts()).tonight).toEqual({ answered: 31 })
    expect(discloseSocial(counts({ tonight: { asked: true, answered: 3 } })).tonight).toEqual({ answered: "few" })
    // 41 of 44 names the 3 who did not answer.
    expect(discloseSocial(counts({ tonight: { asked: true, answered: 41 } })).tonight).toEqual({ answered: "nearly_all" })
    expect(discloseSocial(counts({ tonight: { asked: true, answered: 0 } })).tonight).toEqual({ answered: 0 })
  })

  it("leaves Tonight out when the room asks no question", () => {
    expect(discloseSocial(counts({ tonight: { asked: false, answered: 0 } })).tonight).toBeNull()
  })

  it("counts crews exactly and the people in them as a few under five", () => {
    expect(discloseSocial(counts()).crews).toEqual({ here: 3, people: 9 })
    // Two crews here says at least four people; under five, the count of crews is held too.
    expect(discloseSocial(counts({ crews: { here: 2, people: 4 } })).crews).toEqual({ here: "few", people: "few" })
    expect(discloseSocial(counts({ crews: null })).crews).toBeNull()
  })

  it("carries counts and words only: no id, no name, no answer", () => {
    const text = JSON.stringify(discloseSocial(counts()))
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    for (const v of JSON.stringify(discloseSocial(counts())).match(/"[^"]*"(?=,|})/g) ?? []) {
      expect(["\"few\"", "\"nearly_all\""]).toContain(v)
    }
  })
})

describe("discloseGroup: a total and its parts (every grouped figure on the panel)", () => {
  type Disclosure = ReturnType<typeof discloseGroup>
  const key = (d: Disclosure) => JSON.stringify(d)

  it("never lets the visible numbers give back a hidden part (brute force over three parts, 0 to 12)", () => {
    // Every vector that discloses the same way is indistinguishable to the host:
    // a hidden part must take at least two values across them.
    const range = Array.from({ length: 13 }, (_, i) => i)
    const seen = new Map<string, number[][]>()
    for (const a of range) for (const b of range) for (const c of range) {
      const k = key(discloseGroup([a, b, c]))
      seen.set(k, [...(seen.get(k) ?? []), [a, b, c]])
    }
    let hiddenChecked = 0
    for (const [k, vectors] of seen) {
      const d = JSON.parse(k) as Disclosure
      d.parts.forEach((p, i) => {
        if (p !== "few") return
        hiddenChecked++
        expect(new Set(vectors.map((v) => v[i])).size).toBeGreaterThan(1)
      })
      // And what is shown is the truth.
      for (const v of vectors) {
        d.parts.forEach((p, i) => (p === "few" ? expect(v[i]).toBeLessThan(MIN_CELL) : expect(v[i]).toBe(p)))
        const total = v.reduce((x, y) => x + y, 0)
        if (typeof d.total === "number") expect(total).toBe(d.total)
        else expect(total).toBeGreaterThanOrEqual(d.total.atLeast)
      }
    }
    expect(hiddenChecked).toBeGreaterThan(0)
  })

  it("shows everything exactly when no part is under five (the control)", () => {
    expect(discloseGroup([9, 5, 0])).toEqual({ total: 14, parts: [9, 5, 0] })
    expect(discloseGroup([0, 0, 0])).toEqual({ total: 0, parts: [0, 0, 0] })
  })

  it("holds the total to a floor the moment any part is a few", () => {
    expect(discloseGroup([9, 4, 2])).toEqual({ total: { atLeast: 11 }, parts: [9, "few", "few"] })
    expect(discloseGroup([12, 3, 0])).toEqual({ total: { atLeast: 13 }, parts: [12, "few", 0] })
  })
})

describe("a venue's copy of the snapshot", () => {
  it("is not sent the meeting figures: how people met stays the host's", () => {
    const host = { social: discloseSocial(counts()) } as unknown as LiveSnapshot
    expect(forVenue({ ...host, sentiment: { positive: 0, neutral: 0, negative: 0 }, categories: [], alerts: [] } as LiveSnapshot)).not.toHaveProperty("social")
  })
})
