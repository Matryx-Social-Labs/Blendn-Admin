jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-signals-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { nightsTogether } from "@/lib/crews/signals"
import { db, putInRoom } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person, world, type Person } from "./crew-world"

/**
 * Crew-held signals and size balance on the crew cards (step 10, plan v2 §8.3
 * crew ↔ crew; MV-I07): what a crew holds is two members and a third of the
 * crew; a card says what the crews share and never who or how many; a crew
 * more than twice your crew's size here is damped below one your size; and a
 * crew's own nights together are a badge.
 */

afterAll(async () => {
  await db.user_interests.deleteMany({ where: { user_id: { in: world.users } } })
  await cleanupCrewWorld()
})

const leaf = async (slug: string) => (await db.categories.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id
async function likes(ps: Person[], slug: string) {
  const id = await leaf(slug)
  await db.user_interests.createMany({ data: ps.map((p) => ({ user_id: p.id, category_id: id })), skipDuplicates: true })
}

describe("crew cards: what a crew holds, ranked with size balance (MV-I07)", () => {
  it("names a held interest, never one member's, never a person or a count; a crew of your size outranks one more than twice it", async () => {
    const host = await person("cs-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)

    const me = await person("cs-me")
    const mate = await person("cs-mate")
    const two = await crewOf(me, [mate], "Us Two")
    const s = [await person("cs-s1"), await person("cs-s2")]
    const small = await crewOf(s[0], [s[1]], "Small Lot")
    const b = await Promise.all([1, 2, 3, 4, 5].map((n) => person(`cs-b${n}`)))
    const big = await crewOf(b[0], b.slice(1), "Big Lot")
    // Everyone out to make friends; crew intent is chosen at the crew.
    await db.crews.updateMany({ where: { id: { in: [two.crewId, small.crewId, big.crewId] } }, data: { intent: ["friendship"] } })

    await likes([me, mate, ...s, ...b], "food-drink-italian")
    // One member's taste is not the crew's: only s1 holds Desserts.
    await likes([me, mate, s[0]], "food-drink-desserts")
    // Shared home state, but these crews are under four here: no origin line.
    await db.profiles.updateMany({ where: { id: { in: [me, mate, ...s, ...b].map((p) => p.id) } }, data: { home_state: "kerala" } })

    for (const p of [me, mate, ...s, ...b]) await arrive(eventId, occurrenceId, p)

    // Small's history: a night together ten days ago, after they joined.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600_000)
    await db.crew_members.updateMany({ where: { crew_id: small.crewId }, data: { joined_at: new Date(tenDaysAgo.getTime() - 3600_000) } })
    const past = await liveEvent(host.id)
    // Written closed: a night ten days ago is history, and seating them there would
    // move them out of tonight's room (one open check-in per person, SCRUM-705).
    await db.event_check_ins.createMany({
      data: s.map((p) => ({ event_id: past.eventId, occurrence_id: past.occurrenceId, user_id: p.id, status: "checked_out" as const, check_in_time: tenDaysAgo, check_out_time: tenDaysAgo })),
    })

    const res = await api.atEvent(me, eventId)
    expect(res.status).toBe(200)
    const cards = res.body.data.crews as { crewId: string; presentCount: number; overlaps: { kind: string; text: string }[]; badges: { label: string }[] }[]
    // Big has more here, and would lead on presence alone; five against two is damped.
    expect(cards.map((c) => c.crewId)).toEqual([small.crewId, big.crewId])
    const smallCard = cards[0]
    expect(smallCard.overlaps).toContainEqual({ kind: "interest", text: "Both crews are into Italian" })
    expect(smallCard.overlaps.map((o) => o.text).join(" ")).not.toMatch(/Desserts/)
    expect(cards.flatMap((c) => c.overlaps).filter((o) => o.kind === "home_state" || o.kind === "language")).toEqual([])
    const said = JSON.stringify(cards.map((c) => c.overlaps))
    expect(said).not.toMatch(/\d/)
    expect(said).not.toMatch(/Asha/)
    expect(smallCard.badges).toEqual([{ kind: "nights_together", label: "Out together often" }])
    expect(cards[1].badges).toEqual([])
  })
})

describe("what a crew holds is its members', not who walked in (step 10 review M7)", () => {
  it("a taste held by one member here and one at home is the crew's", async () => {
    const host = await person("cs7-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const me = await person("cs7-me")
    const mate = await person("cs7-mate")
    await crewOf(me, [mate], "Pair Here")
    const t = [await person("cs7-t1"), await person("cs7-t2"), await person("cs7-t3")]
    const trio = await crewOf(t[0], t.slice(1), "Trio")
    await db.crews.updateMany({ where: { id: trio.crewId }, data: { intent: ["friendship"] } })
    await likes([me, mate], "food-drink-bakeries")
    // t1 is here and holds it; t3 holds it and stays home. Held by two of three.
    await likes([t[0], t[2]], "food-drink-bakeries")
    for (const p of [me, mate, t[0], t[1]]) await arrive(eventId, occurrenceId, p)

    const res = await api.atEvent(me, eventId)
    const card = (res.body.data.crews as { crewId: string; overlaps: { text: string }[] }[]).find((c) => c.crewId === trio.crewId)!
    expect(card.overlaps.map((o) => o.text)).toContain("Both crews are into Bakeries")
  })
})

describe("nights together are bounded and cached (step 10 review M6)", () => {
  it("counts the last 180 days only, and reuses a count for a minute", async () => {
    const host = await person("cs6-host")
    const a = await person("cs6-a")
    const b = await person("cs6-b")
    const crew = await crewOf(a, [b], "Old Friends")
    await db.crew_members.updateMany({ where: { crew_id: crew.crewId }, data: { joined_at: new Date(Date.now() - 400 * 24 * 3600_000) } })
    const night = async (daysAgo: number) => {
      const e = await liveEvent(host.id)
      const at = new Date(Date.now() - daysAgo * 24 * 3600_000)
      for (const p of [a, b]) await putInRoom({ eventId: e.eventId, occurrenceId: e.occurrenceId, userId: p.id, at })
    }
    await night(10)
    await night(200) // past the bound
    const now = Date.now()
    expect((await nightsTogether([crew.crewId], now)).get(crew.crewId)).toBe(1)

    await night(20)
    // Within the minute: the cached count.
    expect((await nightsTogether([crew.crewId], now + 30_000)).get(crew.crewId)).toBe(1)
    // After it: read again.
    expect((await nightsTogether([crew.crewId], now + 61_000)).get(crew.crewId)).toBe(2)
  })
})

type Card = { crewId: string; overlaps: { kind: string; text: string }[]; badges: { label: string }[] }
const cardsAt = async (viewer: Person, eventId: string) => (await api.atEvent(viewer, eventId)).body.data.crews as Card[]
const lines = (cards: Card[], crewId: string) => cards.find((c) => c.crewId === crewId)?.overlaps.map((o) => o.text) ?? null

describe("each member's own controls hold inside a crew's lines (the commit scan)", () => {
  /** A crew of three here, liking pan-Asian two-thirds over: held. */
  async function trioNight(label: string) {
    const host = await person(`${label}-host`)
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const me = await person(`${label}-me`)
    const mate = await person(`${label}-mate`)
    await crewOf(me, [mate], "Pair")
    const t = [await person(`${label}-t1`), await person(`${label}-t2`), await person(`${label}-t3`)]
    const trio = await crewOf(t[0], t.slice(1), "Trio")
    await likes([me, mate, t[0], t[1]], "food-drink-pan-asian")
    for (const p of [me, mate, ...t]) await arrive(eventId, occurrenceId, p)
    return { eventId, occurrenceId, me, mate, t, trio }
  }

  it("keep-me-anonymous: their taste is never part of the crew's", async () => {
    const w = await trioNight("csk-anon")
    expect(lines(await cardsAt(w.me, w.eventId), w.trio.crewId)).toContain("Both crews are into Pan-Asian")
    await db.crew_members.updateMany({ where: { crew_id: w.trio.crewId, user_id: w.t[1].id }, data: { keep_me_anonymous: true } })
    // One of three left holding it: not the crew's, so nothing — never a line that points at t1.
    expect(lines(await cardsAt(w.me, w.eventId), w.trio.crewId)).not.toContain("Both crews are into Pan-Asian")
  })

  it("a suspended member is not a member here", async () => {
    const w = await trioNight("csk-susp")
    // t3 joins the taste; t2 is suspended — still two holders (t1, t3), still held.
    await likes([w.t[2]], "food-drink-pan-asian")
    await db.user.update({ where: { id: w.t[1].id }, data: { suspended_at: new Date() } })
    expect(lines(await cardsAt(w.me, w.eventId), w.trio.crewId)).toContain("Both crews are into Pan-Asian")
    // Take t3 off it: one holder among the two active members is half, but one person — never held.
    await db.user_interests.deleteMany({ where: { user_id: w.t[2].id } })
    expect(lines(await cardsAt(w.me, w.eventId), w.trio.crewId)).not.toContain("Both crews are into Pan-Asian")
  })

  it("a crew with anybody kept apart from the viewer is not listed at all", async () => {
    const w = await trioNight("csk-apart")
    await db.blocked_users.create({ data: { blocker_id: w.t[2].id, blocked_id: w.me.id } })
    expect((await cardsAt(w.me, w.eventId)).map((c) => c.crewId)).not.toContain(w.trio.crewId)
  })

  it("Tier B set after the viewer checked in is not used, for any member (H1, per member)", async () => {
    const host = await person("csk-h1-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const mine = [await person("csk-h1-m1"), await person("csk-h1-m2"), await person("csk-h1-m3"), await person("csk-h1-m4")]
    await crewOf(mine[0], mine.slice(1), "Four Here")
    const theirs = [await person("csk-h1-o1"), await person("csk-h1-o2"), await person("csk-h1-o3"), await person("csk-h1-o4")]
    const four = await crewOf(theirs[0], theirs.slice(1), "Other Four")
    await db.profiles.updateMany({ where: { id: { in: [mine[0].id, mine[1].id, theirs[0].id, theirs[1].id] } }, data: { home_state: "kerala" } })
    for (const p of [...mine, ...theirs]) await arrive(eventId, occurrenceId, p)
    expect(lines(await cardsAt(mine[0], eventId), four.crewId)).toContain("Both crews have folks from Kerala")

    // A crewmate of the viewer edits theirs after the viewer checked in: no longer counted.
    await db.profiles.update({ where: { id: mine[1].id }, data: { tier_b_changed_at: new Date() } })
    expect(lines(await cardsAt(mine[0], eventId), four.crewId)).not.toContain("Both crews have folks from Kerala")
  })

  it("'Show my badges' off: their nights add nothing to the crew's", async () => {
    const host = await person("csk-bd-host")
    const a = await person("csk-bd-a")
    const b = await person("csk-bd-b")
    const crew = await crewOf(a, [b], "Badge Pair")
    await db.crew_members.updateMany({ where: { crew_id: crew.crewId }, data: { joined_at: new Date(Date.now() - 30 * 24 * 3600_000) } })
    for (const daysAgo of [5, 9]) {
      const e = await liveEvent(host.id)
      const at = new Date(Date.now() - daysAgo * 24 * 3600_000)
      for (const p of [a, b]) await putInRoom({ eventId: e.eventId, occurrenceId: e.occurrenceId, userId: p.id, at })
    }
    await db.profiles.update({ where: { id: b.id }, data: { show_badges: false } })
    // Two members, one hiding badges: no night has two members who show them.
    expect((await nightsTogether([crew.crewId])).get(crew.crewId)).toBe(0)
  })
})
