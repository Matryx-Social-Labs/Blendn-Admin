/*
 * Post A (SCRUM-1051): what a host is shown of a night, from its counts.
 *
 * Two properties matter more than the arithmetic. Nothing a host can see gives
 * a hidden figure back, by subtraction or by a ratio printed beside it
 * (`discloseGroup`, the coordinator's review of PR 1). And a tally frozen
 * before a figure was counted says so, rather than reading as a real zero.
 */
import { MIN_ATTENDEES } from "@/lib/connection-metrics"
import { MIN_CELL } from "@/lib/disclosure"
import { discloseInsights, type StoredInsightCounts } from "@/lib/event-insights"

/** A night of 40 guests with every figure comfortably over the floors. */
function night(over: { [K in keyof StoredInsightCounts]?: Partial<StoredInsightCounts[K]> } = {}): StoredInsightCounts {
  return {
    connections: { attendees: 40, connections: 15, connected: 20, reachedOut: 30, byWay: { waves: 5, lobby: 5, requests: 5 }, keptTalking: 10, ...over.connections },
    lobby: { offer: 6, seeking: 5, chat: 7, asks: 12, accepted: 6, ...over.lobby },
    tonight: { answered: 24, workIntent: { hire: 0, find_work: 0, build: 0, learn: 0 }, ...over.tonight },
    conversations: 12,
    crews: { came: 3, people: 9, ...over.crews },
    ...(over.conversations !== undefined && { conversations: over.conversations as number }),
  }
}

/**
 * Every input that shows the host the same thing is indistinguishable to them,
 * so a figure shown as hidden must take at least two values across those inputs.
 */
function neverGivesBack<V extends number[]>(vectors: V[], show: (v: V) => unknown, hiddenAt: (shown: never) => number[]) {
  const seen = new Map<string, V[]>()
  for (const v of vectors) {
    const key = JSON.stringify(show(v))
    seen.set(key, [...(seen.get(key) ?? []), v])
  }
  let checked = 0
  for (const [key, same] of seen) {
    for (const i of hiddenAt(JSON.parse(key) as never)) {
      checked++
      expect(new Set(same.map((v) => v[i])).size).toBeGreaterThan(1)
    }
  }
  expect(checked).toBeGreaterThan(0)
}

const grid = (dims: number, max: number): number[][] =>
  dims === 0 ? [[]] : grid(dims - 1, max).flatMap((v) => Array.from({ length: max + 1 }, (_, i) => [...v, i]))

const fewAt = (parts: unknown[]) => parts.flatMap((p, i) => (p === "few" ? [i] : []))

describe("the funnel: came → reached out → met someone → kept talking", () => {
  it("shows each stage as a count and a share of who came", () => {
    const { funnel } = discloseInsights(night(), true)
    expect(funnel).toMatchObject({
      held: false,
      reachedOut: { count: 30, pct: 75 },
      met: { count: 20, pct: 50 },
      keptTalking: { count: 10, pct: 25 },
      connections: 15,
      perAttendee: 0.8,
      byWay: { waves: 5, lobby: 5, requests: 5 },
    })
  })

  it("holds everything about pairs below the pairs floor, and still says who came", () => {
    const insights = discloseInsights(night({ connections: { attendees: MIN_ATTENDEES - 1 } }), true)
    expect(insights.attendees).toBe(MIN_ATTENDEES - 1)
    expect(insights.funnel).toEqual({ held: true, floor: MIN_ATTENDEES })
  })

  it("holds kept talking when fewer than five kept talking, or fewer than five who met did not", () => {
    expect(discloseInsights(night({ connections: { keptTalking: MIN_CELL - 1 } }), true).funnel).toMatchObject({ keptTalking: null })
    expect(discloseInsights(night({ connections: { connected: 20, keptTalking: 17 } }), true).funnel).toMatchObject({ keptTalking: null })
    // The control: five either side is shown.
    expect(discloseInsights(night({ connections: { connected: 20, keptTalking: 15 } }), true).funnel).toMatchObject({ keptTalking: { count: 15 } })
  })

  it("never lets a stage's held figure come back (brute force: kept talking 0 to 20 of 20 who met)", () => {
    neverGivesBack(
      grid(1, 20),
      ([kept]) => discloseInsights(night({ connections: { connected: 20, keptTalking: kept } }), true).funnel,
      (f: { keptTalking: unknown }) => (f.keptTalking === null ? [0] : [])
    )
  })

  it("never lets the total or the per-person figure give back a way shown as a few (brute force, each way 0 to 9)", () => {
    neverGivesBack(
      grid(3, 9),
      ([waves, lobby, requests]) =>
        discloseInsights(night({ connections: { connections: waves + lobby + requests, byWay: { waves, lobby, requests } } }), true).funnel,
      (f: { byWay: { waves: unknown; lobby: unknown; requests: unknown } }) => fewAt([f.byWay.waves, f.byWay.lobby, f.byWay.requests])
    )
  })

  it("prints the total as a floor and drops the per-person figure when a way is a few", () => {
    const { funnel } = discloseInsights(night({ connections: { connections: 14, byWay: { waves: 10, lobby: 3, requests: 1 } } }), true)
    expect(funnel).toMatchObject({ connections: { atLeast: 12 }, perAttendee: null, byWay: { waves: 10, lobby: "few", requests: "few" } })
  })

  it("says not recorded, never zero, for a tally frozen before the split and kept talking were counted", () => {
    const legacy = night()
    delete (legacy.connections as { byWay?: unknown }).byWay
    delete (legacy.connections as { keptTalking?: unknown }).keptTalking
    const { funnel } = discloseInsights(legacy, true)
    // With no parts shown the total is exact, as it always was.
    expect(funnel).toMatchObject({ connections: 15, perAttendee: 0.8, byWay: null, keptTalking: "not_recorded" })
  })
})

describe("the Lobby", () => {
  it("never lets the posts total give back a kind shown as a few (brute force, each kind 0 to 9)", () => {
    neverGivesBack(
      grid(3, 9),
      ([offer, seeking, chat]) => discloseInsights(night({ lobby: { offer, seeking, chat } }), true).lobby,
      (l: { offer: unknown; seeking: unknown; chat: unknown }) => fewAt([l.offer, l.seeking, l.chat])
    )
  })

  it("shows asks, and the accepted only when they and the rest both reach five", () => {
    expect(discloseInsights(night(), true).lobby).toEqual({ posts: 18, offer: 6, seeking: 5, chat: 7, asks: 12, accepted: 6 })
    expect(discloseInsights(night({ lobby: { asks: 12, accepted: 9 } }), true).lobby.accepted).toBeNull()
    expect(discloseInsights(night({ lobby: { asks: 3, accepted: 1 } }), true).lobby).toMatchObject({ asks: "few", accepted: null })
  })

  it("never lets accepted asks come back (brute force: 0 to 15 of 15 asks)", () => {
    neverGivesBack(
      grid(1, 15),
      ([accepted]) => discloseInsights(night({ lobby: { asks: 15, accepted } }), true).lobby,
      (l: { accepted: unknown }) => (l.accepted === null ? [0] : [])
    )
  })
})

describe("Tonight's question and crews", () => {
  it("shows answered of who came, nearly all when the rest are a few, and nothing when the room asked none", () => {
    expect(discloseInsights(night(), true).tonight).toMatchObject({ answered: 24, pct: 60 })
    expect(discloseInsights(night({ tonight: { answered: 37 } }), true).tonight).toMatchObject({ answered: "nearly_all", pct: null })
    expect(discloseInsights(night({ tonight: { answered: 3 } }), true).tonight).toMatchObject({ answered: "few", pct: null })
    expect(discloseInsights(night({ tonight: { answered: 0 } }), false).tonight).toBeNull()
  })

  it("never lets the work-intent mix give back an intent shown as a few (brute force, each of four 0 to 6)", () => {
    neverGivesBack(
      grid(4, 6),
      ([hire, find_work, build, learn]) => discloseInsights(night({ tonight: { workIntent: { hire, find_work, build, learn } } }), true).tonight,
      (t: { workIntent: { parts: Record<string, unknown> } | null }) => (t.workIntent ? fewAt(Object.values(t.workIntent.parts)) : [])
    )
  })

  it("has no mix on a night nobody said why they came", () => {
    expect(discloseInsights(night(), true).tonight?.workIntent).toBeNull()
  })

  it("holds crews with their people while the people are a few, since two crews already say four people", () => {
    expect(discloseInsights(night({ crews: { came: 2, people: 4 } }), true).crews).toEqual({ came: "few", people: "few" })
    expect(discloseInsights(night({ crews: { came: 0, people: 0 } }), true).crews).toEqual({ came: 0, people: 0 })
    expect(discloseInsights(night({ crews: { came: 2, people: 5 } }), true).crews).toEqual({ came: 2, people: 5 })
  })

  it("never lets crews give their people back (brute force: 0 to 4 crews, 0 to 12 people)", () => {
    neverGivesBack(
      grid(2, 12).filter(([came, people]) => came <= 4 && people >= 2 * came && (came > 0 || people === 0)),
      ([came, people]) => discloseInsights(night({ crews: { came, people } }), true).crews,
      (c: { people: unknown }) => (c.people === "few" ? [1] : [])
    )
  })
})

describe("frozen before Post A", () => {
  it("says not recorded for conversations and crews", () => {
    const legacy = night() as Partial<StoredInsightCounts>
    delete legacy.conversations
    delete legacy.crews
    const insights = discloseInsights(legacy as StoredInsightCounts, true)
    expect(insights.conversations).toBe("not_recorded")
    expect(insights.crews).toBe("not_recorded")
  })
})

describe("what leaves the server", () => {
  it("is counts, shares and words for held figures: never an id", () => {
    const leaves = (v: unknown): unknown[] => (v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v])
    for (const leaf of leaves(discloseInsights(night({ crews: { came: 1, people: 2 } }), true))) {
      if (typeof leaf === "string") expect(["few", "nearly_all", "not_recorded"]).toContain(leaf)
      else expect(leaf === null || typeof leaf === "number" || typeof leaf === "boolean").toBe(true)
    }
  })
})
