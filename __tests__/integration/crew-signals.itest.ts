jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-signals-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

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

    await likes([me, mate, ...s, ...b], "food-drink-dosa")
    // One member's taste is not the crew's: only s1 holds Biryani.
    await likes([me, mate, s[0]], "food-drink-biryani")
    // Shared home state, but these crews are under four here: no origin line.
    await db.profiles.updateMany({ where: { id: { in: [me, mate, ...s, ...b].map((p) => p.id) } }, data: { home_state: "kerala" } })

    for (const p of [me, mate, ...s, ...b]) await arrive(eventId, occurrenceId, p)

    // Small's history: a night together ten days ago, after they joined.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600_000)
    await db.crew_members.updateMany({ where: { crew_id: small.crewId }, data: { joined_at: new Date(tenDaysAgo.getTime() - 3600_000) } })
    const past = await liveEvent(host.id)
    for (const p of s) await putInRoom({ eventId: past.eventId, occurrenceId: past.occurrenceId, userId: p.id, at: tenDaysAgo })
    await db.event_check_ins.updateMany({ where: { event_id: past.eventId }, data: { status: "checked_out", check_out_time: tenDaysAgo } })

    const res = await api.atEvent(me, eventId)
    expect(res.status).toBe(200)
    const cards = res.body.data.crews as { crewId: string; presentCount: number; overlaps: { kind: string; text: string }[]; badges: { label: string }[] }[]
    // Big has more here, and would lead on presence alone; five against two is damped.
    expect(cards.map((c) => c.crewId)).toEqual([small.crewId, big.crewId])
    const smallCard = cards[0]
    expect(smallCard.overlaps).toContainEqual({ kind: "interest", text: "Both crews are into Dosa" })
    expect(smallCard.overlaps.map((o) => o.text).join(" ")).not.toMatch(/Biryani/)
    expect(cards.flatMap((c) => c.overlaps).filter((o) => o.kind === "home_state" || o.kind === "language")).toEqual([])
    const said = JSON.stringify(cards.map((c) => c.overlaps))
    expect(said).not.toMatch(/\d/)
    expect(said).not.toMatch(/Asha/)
    expect(smallCard.badges).toEqual([{ kind: "nights_together", label: "2 nights out together" }])
    expect(cards[1].badges).toEqual([])
  })
})
