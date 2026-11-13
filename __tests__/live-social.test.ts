import { discloseSocial, type LiveSocialCounts } from "@/lib/live-social"
import { forVenue, type LiveSnapshot } from "@/lib/live-metrics"

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
    expect(s.met).toEqual({ held: false, pct: 52, connected: 23, connections: 15, byWay: { waves: 9, lobby: "few", requests: "few" } })
  })

  it("holds every connection figure back under the pairs floor, and still shows the rest", () => {
    const s = discloseSocial(counts({ connections: { attendees: 7, connections: 2, connected: 4, reachedOut: 5, byWay: { waves: 2, lobby: 0, requests: 0 } } }))
    expect(s.met).toEqual({ held: true, floor: 8 })
    expect(s.conversations).toBe(12)
  })

  it("says a few for one to four, and zero as zero: an empty Lobby names nobody", () => {
    const s = discloseSocial(counts({ conversations: 4, lobby: { offer: 1, seeking: 0, chat: 5 } }))
    expect(s.conversations).toBe("few")
    expect(s.lobby).toEqual({ posts: 6, offer: "few", seeking: 0, chat: 5 })
    expect(discloseSocial(counts({ conversations: 0 })).conversations).toBe(0)
    expect(discloseSocial(counts({ conversations: 5 })).conversations).toBe(5)
  })

  it("says the total Lobby posts as a few too when there are fewer than five", () => {
    expect(discloseSocial(counts({ lobby: { offer: 1, seeking: 1, chat: 1 } })).lobby.posts).toBe("few")
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
    expect(discloseSocial(counts({ crews: { here: 2, people: 4 } })).crews).toEqual({ here: 2, people: "few" })
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

describe("a venue's copy of the snapshot", () => {
  it("is not sent the meeting figures: how people met stays the host's", () => {
    const host = { social: discloseSocial(counts()) } as unknown as LiveSnapshot
    expect(forVenue({ ...host, sentiment: { positive: 0, neutral: 0, negative: 0 }, categories: [], alerts: [] } as LiveSnapshot)).not.toHaveProperty("social")
  })
})
