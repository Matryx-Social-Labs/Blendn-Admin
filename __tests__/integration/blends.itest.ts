/*
 * Crew matching, Blends and the crew reveal, end to end on a migrate-deploy
 * database (step 8: TQ-A12 CR-I06..I10, CR-G03 at the API; TQ-X07 CR-I11/I12,
 * SEC-03/04/06; TQ-B06 CR-I13/CR-K04; TQ-S07 CR-K03, CR-I14, CR-K06).
 * Real routes, real rows, the real socket server.
 *
 * The mutations each block is written against are in negative-controls.json.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-blends-secret-of-32-characters-xxxxx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { conversationPair } from "@/lib/conversations"
import { purgeLapsedCrewLikes } from "@/lib/crews/sweep"
import { canJoinChat } from "@/lib/socket-auth"
import { roomHandle } from "@/lib/room-handle"
import { db, testId } from "./helpers"
import { api, arrive, befriend, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, until, type Person } from "./crew-world"

const sockets = socketHarness()
beforeAll(() => sockets.start())
afterAll(async () => {
  await sockets.stop()
  await cleanupCrewWorld()
})

/** Two crews of three at one live event, everyone here with a pseudonym. */
async function twoCrews(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const [a1, a2, a3] = await Promise.all(["a1", "a2", "a3"].map((l) => person(`${label}-${l}`, `Ananya ${l} Bhat`)))
  const [b1, b2, b3] = await Promise.all(["b1", "b2", "b3"].map((l) => person(`${label}-${l}`, `Vikram ${l} Shetty`)))
  const A = await crewOf(a1, [a2, a3], "Crew Two")
  const B = await crewOf(b1, [b2, b3], "Crew Five")
  const pseudonyms = new Map<string, string>()
  for (const p of [a1, a2, b1, b2]) pseudonyms.set(p.id, await arrive(eventId, occurrenceId, p))
  return { eventId, occurrenceId, A, B, a: [a1, a2, a3], b: [b1, b2, b3], pseudonyms }
}

const blendRows = (occurrenceId: string) => db.blends.findMany({ where: { occurrence_id: occurrenceId }, select: { id: true, room: { select: { id: true } } } })

describe("the database holds the shape", () => {
  it("refuses a like with no crew, two senders, a crew liking itself, or a solo like made for somebody else", async () => {
    const w = await twoCrews("db")
    const insert = (cols: Record<string, string | null>) =>
      db.$executeRawUnsafe(
        `INSERT INTO crew_likes (occurrence_id, from_crew_id, from_user_id, to_crew_id, to_user_id, liked_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)`,
        w.occurrenceId,
        cols.fromCrew ?? null,
        cols.fromUser ?? null,
        cols.toCrew ?? null,
        cols.toUser ?? null,
        cols.by ?? w.a[0].id
      )
    await expect(insert({ fromUser: w.a[0].id, toUser: w.b[0].id })).rejects.toThrow(/crew_likes_has_a_crew/)
    await expect(insert({ fromCrew: w.A.crewId, fromUser: w.a[0].id, toCrew: w.B.crewId })).rejects.toThrow(/crew_likes_one_from/)
    await expect(insert({ fromCrew: w.A.crewId, toCrew: w.B.crewId, toUser: w.b[0].id })).rejects.toThrow(/crew_likes_one_to/)
    await expect(insert({ fromCrew: w.A.crewId, toCrew: w.A.crewId })).rejects.toThrow(/crew_likes_not_self/)
    await expect(insert({ fromUser: w.b[0].id, toCrew: w.A.crewId, by: w.a[0].id })).rejects.toThrow(/crew_likes_solo_is_the_liker/)
    // Liking twice is liking once.
    await insert({ fromCrew: w.A.crewId, toCrew: w.B.crewId })
    await expect(insert({ fromCrew: w.A.crewId, toCrew: w.B.crewId, by: w.a[1].id })).rejects.toThrow(/23505/)
  })

  it("orders a pair of crews one way only, and makes one Blend per pair per occurrence", async () => {
    const w = await twoCrews("dbb")
    const [lo, hi] = [w.A.crewId, w.B.crewId].sort()
    const insert = (a: string, b: string | null, solo: string | null) =>
      db.$executeRawUnsafe(
        `INSERT INTO blends (occurrence_id, a_crew_id, b_crew_id, b_user_id, closes_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 hour')`,
        w.occurrenceId,
        a,
        b,
        solo
      )
    await expect(insert(hi, lo, null)).rejects.toThrow(/blends_pair_order/)
    await expect(insert(lo, hi, w.a[0].id)).rejects.toThrow(/blends_one_b/)
    await expect(insert(lo, null, null)).rejects.toThrow(/blends_one_b/)
    await insert(lo, hi, null)
    await expect(insert(lo, hi, null)).rejects.toThrow(/23505/)
    // A Blend room needs its Blend; one per Blend.
    const blend = await db.blends.findFirstOrThrow({ where: { occurrence_id: w.occurrenceId }, select: { id: true } })
    const room = (blendId: string | null) =>
      db.$executeRawUnsafe(`INSERT INTO chat_groups (id, name, kind, blend_id) VALUES (gen_random_uuid(), 'x', 'blend', $1::uuid)`, blendId)
    await expect(room(null)).rejects.toThrow(/chat_groups_one_owner/)
    await room(blend.id)
    await expect(room(blend.id)).rejects.toThrow(/chat_groups_blend_id_key/)
  })
})

describe("crew ↔ crew: any present member likes for the crew; mutual is one Blend (CR-I06, CR-I07)", () => {
  it("one like is told to nobody outside the crew; the like back makes one Blend whose room is the people here", async () => {
    const w = await twoCrews("cc")
    const [a1, a2, a3] = w.a
    const [b1, b2, b3] = w.b
    // a3 is a member of Crew Two but not here; b3 neither.

    const first = await api.likeCrew(a2, w.eventId, w.B.crewId, w.A.crewId)
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ liked: true, blend: null })
    // The crew chat says who liked, for the crew: transparency, not a vote.
    const line = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: w.A.roomId, type: "system" }, select: { user_id: true, content: true } })
    expect(line).toEqual({ user_id: a2.id, content: "liked Crew Five for the crew" })
    // Nobody on the other side learns of it: no bell row, and their card says nothing.
    expect(await db.notifications.count({ where: { user_id: { in: [b1.id, b2.id, b3.id] } , kind: "blend" } })).toBe(0)
    const theirCard = (await api.atEvent(b1, w.eventId)).body.data.crews.find((c: { crewId: string }) => c.crewId === w.A.crewId)
    expect(theirCard.youLiked).toBe(false)
    const ourCard = (await api.atEvent(a1, w.eventId)).body.data.crews.find((c: { crewId: string }) => c.crewId === w.B.crewId)
    expect(ourCard.youLiked).toBe(true)

    // Any member of the other crew likes back.
    const back = await api.likeCrew(b2, w.eventId, w.A.crewId, w.B.crewId)
    expect(back.status).toBe(200)
    expect(back.body.data.blend).toEqual({ blendId: expect.any(String), chatGroupId: expect.any(String) })
    const rows = await blendRows(w.occurrenceId)
    expect(rows).toHaveLength(1)
    const roomId = back.body.data.blend.chatGroupId
    expect(rows[0].room?.id).toBe(roomId)
    const blend = await db.blends.findUniqueOrThrow({ where: { id: rows[0].id }, select: { a_crew_id: true, b_crew_id: true, closes_at: true } })
    expect([blend.a_crew_id, blend.b_crew_id]).toEqual([w.A.crewId, w.B.crewId].sort())
    const occurrence = await db.event_occurrences.findUniqueOrThrow({ where: { id: w.occurrenceId }, select: { end_time: true } })
    expect(blend.closes_at.getTime()).toBe(occurrence.end_time.getTime() + 12 * 60 * 60 * 1000)

    // The room is the present members of both sides — a3 and b3 are not here.
    const roster = await api.roster(a1, roomId)
    expect(roster.status).toBe(200)
    expect(roster.body.data.participants.map((p: { name: string }) => p.name).sort()).toEqual(
      [a1, a2, b1, b2].map((p) => w.pseudonyms.get(p.id)).sort()
    )
    expect(await canJoinChat(a3.id, roomId)).toBe(false)
    expect((await api.read(b3, roomId)).status).toBe(403)
    // "It's a Blend" to everyone let in but the person whose like made it; naming nobody.
    const told = await db.notifications.findMany({ where: { kind: "blend", user_id: { in: [a1, a2, a3, b1, b2, b3].map((p) => p.id) } }, select: { user_id: true, body: true } })
    expect(told.map((t) => t.user_id).sort()).toEqual([a1.id, a2.id, b1.id].sort())
    expect(told.every((t) => !/Ananya|Vikram|Crew/.test(t.body))).toBe(true)

    // The room is a snapshot of who was here when it matched (C3): a3 checks
    // in later and has no row — not let in, not on the roster.
    await arrive(w.eventId, w.occurrenceId, a3)
    expect(await db.chat_group_members.count({ where: { chat_group_id: roomId, user_id: a3.id } })).toBe(0)
    expect(await canJoinChat(a3.id, roomId)).toBe(false)
    expect((await api.read(a3, roomId)).status).toBe(403)
    expect((await api.roster(a1, roomId)).body.data.participants).toHaveLength(4)
  })

  it("two crews liking each other at the same instant make exactly one Blend, every time (the race)", async () => {
    for (let i = 0; i < 5; i++) {
      const w = await twoCrews(`race${i}`)
      const [x, y] = await Promise.all([
        api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId),
        api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId),
      ])
      expect([x.status, y.status]).toEqual([200, 200])
      const rows = await blendRows(w.occurrenceId)
      expect(rows).toHaveLength(1)
      // Both answers point at it, or one of them does: never a second room.
      const pointed = [x.body.data.blend, y.body.data.blend].filter(Boolean).map((b: { chatGroupId: string }) => b.chatGroupId)
      expect(pointed.length).toBeGreaterThanOrEqual(1)
      expect(new Set(pointed)).toEqual(new Set([rows[0].room?.id]))
      expect(await db.chat_groups.count({ where: { blend_id: rows[0].id } })).toBe(1)
    }
  })

  it("refuses a like from a crew that is not here, on a crew that is not here, and across a block (CR-I09)", async () => {
    const w = await twoCrews("cg")
    const host = await person("cg-host2")
    const other = await liveEvent(host.id)
    // Crew Five is at the other event too; of Crew Two only a1 is, so Crew Two is not "here" there.
    for (const p of [w.a[0], w.b[0], w.b[1]]) await arrive(other.eventId, other.occurrenceId, p)
    expect((await api.likeCrew(w.a[0], other.eventId, w.B.crewId, w.A.crewId)).status).toBe(403)
    // A crew with one member here is no crew here.
    await db.event_check_ins.updateMany({ where: { event_id: w.eventId, user_id: w.b[1].id }, data: { status: "checked_out", check_out_time: new Date() } })
    expect((await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)).status).toBe(404)
    await db.event_check_ins.updateMany({ where: { event_id: w.eventId, user_id: w.b[1].id }, data: { status: "checked_in", check_out_time: null } })
    // A block between two members neither of whom is liking: the same 404 as no crew.
    await db.blocked_users.create({ data: { blocker_id: w.b[2].id, blocked_id: w.a[2].id } })
    const res = await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)
    expect(res).toEqual({ status: 404, body: expect.objectContaining({ error: "Crew not found" }) })
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })
})

describe("crew ↔ person: the person opts in, the crew has room for one more, dating only if both chose it (CR-I08)", () => {
  async function soloWorld(label: string, opts: { crewSize?: number; crewIntent?: ("dating" | "friendship")[] } = {}) {
    const host = await person(`${label}-host`)
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const solo = await person(`${label}-solo`, "Meera Iyer")
    const crew = await Promise.all(Array.from({ length: opts.crewSize ?? 3 }, (_, i) => person(`${label}-c${i}`)))
    const C = await crewOf(crew[0], crew.slice(1), "Room For One")
    await db.crews.update({ where: { id: C.crewId }, data: { open_to_solo: true, intent: opts.crewIntent ?? ["friendship"] } })
    const soloPseudonym = await arrive(eventId, occurrenceId, solo)
    for (const p of crew.slice(0, 2)) await arrive(eventId, occurrenceId, p)
    return { eventId, occurrenceId, solo, crew, C, soloPseudonym }
  }

  it("a person who opted in likes a crew, a member likes them back for the crew: one Blend, the crew and the person", async () => {
    const w = await soloWorld("cp")
    // Not opted in yet: refused, and told why — it is their own switch.
    const early = await api.likeCrew(w.solo, w.eventId, w.C.crewId)
    expect(early.status).toBe(403)
    expect(early.body.error).toMatch(/Open to joining a crew tonight/)
    expect((await api.prefs(w.solo, w.eventId, { openToCrews: true })).body.data).toMatchObject({ openToCrews: true })
    expect((await api.likeCrew(w.solo, w.eventId, w.C.crewId)).body.data).toEqual({ liked: true, blend: null })

    // The crew member likes the person by their handle in the event's room.
    const handle = roomHandle(w.eventId, w.solo.id)
    const back = await api.likePerson(w.crew[1], w.eventId, handle, w.C.crewId)
    expect(back.status).toBe(200)
    expect(back.body.data.blend).toEqual({ blendId: expect.any(String), chatGroupId: expect.any(String) })
    const blend = await db.blends.findFirstOrThrow({ where: { occurrence_id: w.occurrenceId }, select: { a_crew_id: true, b_crew_id: true, b_user_id: true } })
    expect(blend).toEqual({ a_crew_id: w.C.crewId, b_crew_id: null, b_user_id: w.solo.id })
    const roster = await api.roster(w.solo, back.body.data.blend.chatGroupId)
    expect(roster.body.data.participants).toHaveLength(3)
    // No line in the crew chat for a like of a person: a line only for a like
    // that stood would tell the crew what the answer hides (step 8 follow-up).
    expect(await db.chat_messages.count({ where: { chat_group_id: w.C.roomId, type: "system" } })).toBe(0)
    void w.soloPseudonym
  })

  it("refuses each guardrail: a crew without room for one more, a crew of seven, dating one-sided, a person who did not opt in", async () => {
    // A refusal about the PERSON answers as a like that stood, and stores nothing (C7).
    const nothingTold = { status: 200, body: expect.objectContaining({ data: { liked: true, blend: null } }) }

    const closed = await soloWorld("g1")
    await db.crews.update({ where: { id: closed.C.crewId }, data: { open_to_solo: false } })
    await api.prefs(closed.solo, closed.eventId, { openToCrews: true })
    expect((await api.likeCrew(closed.solo, closed.eventId, closed.C.crewId)).status).toBe(404)
    // About the liker's own crew: said (403), it is theirs to change.
    expect((await api.likePerson(closed.crew[0], closed.eventId, roomHandle(closed.eventId, closed.solo.id), closed.C.crewId)).status).toBe(403)

    const big = await soloWorld("g2", { crewSize: 7 })
    await api.prefs(big.solo, big.eventId, { openToCrews: true })
    expect((await api.likeCrew(big.solo, big.eventId, big.C.crewId)).status).toBe(404)
    expect((await api.likePerson(big.crew[0], big.eventId, roomHandle(big.eventId, big.solo.id), big.C.crewId)).status).toBe(403)

    const dating = await soloWorld("g3", { crewIntent: ["dating"] })
    await api.prefs(dating.solo, dating.eventId, { openToCrews: true, intent: ["friendship"] })
    expect((await api.likeCrew(dating.solo, dating.eventId, dating.C.crewId)).status).toBe(404)
    expect(await api.likePerson(dating.crew[0], dating.eventId, roomHandle(dating.eventId, dating.solo.id), dating.C.crewId)).toEqual(nothingTold)
    expect(await db.crew_likes.count({ where: { occurrence_id: dating.occurrenceId, to_user_id: dating.solo.id } })).toBe(0)
    // Both chose it: allowed.
    await api.prefs(dating.solo, dating.eventId, { intent: ["dating"] })
    expect((await api.likeCrew(dating.solo, dating.eventId, dating.C.crewId)).status).toBe(200)

    // Not opted in, kept apart (a closed conversation), not here: each the same answer as a like that stood.
    const shy = await soloWorld("g4")
    expect(await api.likePerson(shy.crew[0], shy.eventId, roomHandle(shy.eventId, shy.solo.id), shy.C.crewId)).toEqual(nothingTold)
    await api.prefs(shy.solo, shy.eventId, { openToCrews: true })
    const [user1_id, user2_id] = conversationPair(shy.crew[2].id, shy.solo.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: shy.solo.id, closed_reason: "unmatch" } })
    expect(await api.likePerson(shy.crew[0], shy.eventId, roomHandle(shy.eventId, shy.solo.id), shy.C.crewId)).toEqual(nothingTold)
    await db.private_conversations.deleteMany({ where: { user1_id, user2_id } })
    await db.event_check_ins.updateMany({ where: { event_id: shy.eventId, user_id: shy.solo.id }, data: { status: "checked_out", check_out_time: new Date() } })
    expect(await api.likePerson(shy.crew[0], shy.eventId, roomHandle(shy.eventId, shy.solo.id), shy.C.crewId)).toEqual(nothingTold)
    expect(await db.crew_likes.count({ where: { occurrence_id: { in: [closed.occurrenceId, big.occurrenceId, shy.occurrenceId] } } })).toBe(0)
    // And the liker's crew chat is as silent after a refused like as after one that stood.
    expect(await db.chat_messages.count({ where: { chat_group_id: { in: [shy.C.roomId, dating.C.roomId] }, type: "system" } })).toBe(0)
  })
})

describe("in the Blend: pseudonyms, the crew reveal with its opt-out, leaving alone, a block, the clock", () => {
  async function blended(label: string) {
    const w = await twoCrews(label)
    await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)
    const back = await api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId)
    return { ...w, roomId: back.body.data.blend.chatGroupId as string, blendId: back.body.data.blend.blendId as string }
  }

  it("speaks in tonight's pseudonyms, over REST and the socket, to its people only (CR-K06)", async () => {
    const w = await blended("talk")
    const [a1] = w.a
    const [b1] = w.b
    const listener = await sockets.online(b1)
    expect(await sockets.joins(listener, w.roomId)).toBe(true)
    const outsider = await sockets.online(w.a[2])
    expect(await sockets.joins(outsider, w.roomId)).toBe(false)
    expect((await api.send(a1, w.roomId, "hello crew five")).status).toBe(201)
    expect(await until(() => listener.heard.message.some((m) => m.message.content === "hello crew five"))).toBe(true)
    const heard = listener.heard.message.find((m) => m.message.content === "hello crew five")!
    expect(heard.message.userName).toBe(w.pseudonyms.get(a1.id))
    expect(heard.message.userId).toMatch(/^rh_/)
    expect(outsider.heard.message).toHaveLength(0)
    const history = await api.read(b1, w.roomId)
    const line = history.body.data.messages.find((m: { content: string }) => m.content === "hello crew five")
    expect(line.user.name).toBe(w.pseudonyms.get(a1.id))
    expect(JSON.stringify(history.body)).not.toMatch(/Ananya|Bhat/)
    // A Blend handle names nobody at the event (CR-I12): the event's like route answers it as nobody.
    expect((await api.likePerson(b1, w.eventId, line.user.id)).status).toBe(404)
  })

  it("one tap reveals the crew IN THIS BLEND — everyone here who consented, never somebody keeping themselves anonymous (CR-I11, C2, D-10)", async () => {
    const w = await blended("rev")
    const [a1, a2] = w.a
    const [b1] = w.b
    // A bystander at the same event, in neither crew.
    const bystander = await person("rev-bystander")
    await arrive(w.eventId, w.occurrenceId, bystander)
    // a2 keeps themselves anonymous.
    expect((await api.settings(a2, w.A.crewId, true)).status).toBe(200)

    const tap = await api.reveal(a1, w.blendId)
    expect(tap.status).toBe(200)
    // No count back: the tapper is in the crew, and "1 kept private" says which crewmate (step 9 review, H3).
    expect(tap.body.data).toEqual({ revealed: true })
    expect((await db.blend_reveals.findMany({ where: { blend_id: w.blendId }, select: { user_id: true } })).map((r) => r.user_id)).toEqual([a1.id])
    // Scoped to the Blend: no event-wide reveal, no DM touched.
    expect(await db.event_match_preferences.count({ where: { event_id: w.eventId, revealed: true } })).toBe(0)

    // The other side sees a1's first name — never the full one — and a2 as a pseudonym.
    const seen = (await api.blends(b1)).body.data.blends.find((b: { blendId: string }) => b.blendId === w.blendId)
    const side = seen.sides.find((s: { crewId: string }) => s.crewId === w.A.crewId)
    expect(side).toMatchObject({ mine: false, count: 2, revealed: 1, keptPrivate: 1 })
    // a1's own side, to a1: a count and a1 — never who of the crew revealed or kept private.
    const own = (await api.blends(a1)).body.data.blends.find((b: { blendId: string }) => b.blendId === w.blendId)
      .sides.find((s: { crewId: string }) => s.crewId === w.A.crewId)
    expect(own).toMatchObject({ mine: true, count: 2, revealed: null, keptPrivate: null })
    expect(own.people.map((p: { userId: string }) => p.userId)).toEqual([a1.id])
    const byPseudonym = new Map(side.people.map((p: { pseudonym: string; name: string | null }) => [p.pseudonym, p.name]))
    expect(byPseudonym.get(w.pseudonyms.get(a1.id))).toBe("Ananya")
    expect(byPseudonym.get(w.pseudonyms.get(a2.id))).toBeNull()
    expect(JSON.stringify(seen)).not.toMatch(/Bhat/)
    // The bystander at the event sees nobody named: the event's roster is its own rule, untouched.
    const roster = await api.checkins(bystander, w.eventId)
    expect(roster.status).toBe(200)
    expect(roster.body.data.attendees.length).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(roster.body)).not.toMatch(/Ananya|Bhat/)
    // Nowhere else either: no bell row carries a name.
    const rows = await db.notifications.findMany({ where: { user_id: { in: [b1.id, w.b[1].id] } }, select: { title: true, body: true } })
    expect(rows.every((r) => !/Ananya|Bhat/.test(`${r.title} ${r.body}`))).toBe(true)

    // D-10: switching it on after a reveal applies from then on — a1's stays.
    await api.settings(a1, w.A.crewId, true)
    await api.settings(a2, w.A.crewId, false)
    // a2 checks out before the next tap: here now only, so the tap does not reveal them.
    await db.event_check_ins.updateMany({ where: { event_id: w.eventId, user_id: a2.id }, data: { status: "checked_out", check_out_time: new Date() } })
    expect((await api.reveal(a1, w.blendId)).body.data).toEqual({ revealed: true })
    expect((await db.blend_reveals.findMany({ where: { blend_id: w.blendId }, select: { user_id: true } })).map((r) => r.user_id)).toEqual([a1.id])
    // Somebody not in this Blend cannot tap it: the same 404 as no Blend.
    expect((await api.reveal(bystander, w.blendId)).status).toBe(404)
  })

  it("a reveal in one Blend names nobody in another Blend of the same crew", async () => {
    const w = await blended("rev2")
    const [a1] = w.a
    const [c1, c2] = await Promise.all(["c1", "c2"].map((l) => person(`rev2-${l}`)))
    const C = await crewOf(c1, [c2], "Crew Nine")
    for (const p of [c1, c2]) await arrive(w.eventId, w.occurrenceId, p)
    await api.likeCrew(a1, w.eventId, C.crewId, w.A.crewId)
    const other = await api.likeCrew(c1, w.eventId, w.A.crewId, C.crewId)
    const otherBlend = other.body.data.blend.blendId as string
    expect((await api.reveal(a1, w.blendId)).body.data).toEqual({ revealed: true })
    expect(await db.blend_reveals.count({ where: { blend_id: w.blendId, user_id: a1.id } })).toBe(1)
    const seenByC = (await api.blends(c1)).body.data.blends.find((b: { blendId: string }) => b.blendId === otherBlend)
    expect(seenByC).toBeDefined()
    expect(JSON.stringify(seenByC)).not.toMatch(/Ananya/)
  })

  it("the matched person reveals only themselves", async () => {
    const host = await person("rv-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const solo = await person("rv-solo", "Meera Iyer")
    const crew = await Promise.all(["c0", "c1"].map((l) => person(`rv-${l}`, `Kiran ${l} Rao`)))
    const C = await crewOf(crew[0], [crew[1]], "Room For One")
    await db.crews.update({ where: { id: C.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    for (const p of [solo, ...crew]) await arrive(eventId, occurrenceId, p)
    await api.prefs(solo, eventId, { openToCrews: true })
    await api.likeCrew(solo, eventId, C.crewId)
    const back = await api.likePerson(crew[0], eventId, roomHandle(eventId, solo.id), C.crewId)
    const blendId = back.body.data.blend.blendId as string
    expect((await api.reveal(solo, blendId)).body.data).toEqual({ revealed: true })
    expect((await db.blend_reveals.findMany({ where: { blend_id: blendId }, select: { user_id: true } })).map((r) => r.user_id)).toEqual([solo.id])
    const seen = (await api.blends(crew[1])).body.data.blends.find((b: { blendId: string }) => b.blendId === blendId)
    expect(seen.sides.find((s: { kind: string }) => s.kind === "person").people[0].name).toBe("Meera")
    // Her side is theirs to the crew (a count of one, revealed 1); to her it is hers: herself, no counts.
    expect(seen.sides.find((s: { kind: string }) => s.kind === "person")).toMatchObject({ mine: false, count: 1, revealed: 1, keptPrivate: 0 })
    const hers = (await api.blends(solo)).body.data.blends.find((b: { blendId: string }) => b.blendId === blendId)
    expect(hers.sides.find((s: { kind: string }) => s.kind === "person")).toMatchObject({ mine: true, count: 1, revealed: null, keptPrivate: null })
    expect(hers.sides.find((s: { kind: string }) => s.kind === "crew")).toMatchObject({ mine: false })
    // And the crew stays anonymous to the person: her tap named only her.
    const theirs = (await api.blends(solo)).body.data.blends.find((b: { blendId: string }) => b.blendId === blendId)
    expect(JSON.stringify(theirs.sides.find((s: { kind: string }) => s.kind === "crew"))).not.toMatch(/Kiran/)
  })

  it("anyone can leave alone; the room stays for the rest (CR-I14)", async () => {
    const w = await blended("leave")
    expect((await api.leave(w.a[1], w.roomId)).status).toBe(200)
    expect((await api.read(w.a[1], w.roomId)).status).toBe(403)
    expect((await api.read(w.a[0], w.roomId)).status).toBe(200)
    expect((await api.roster(w.b[0], w.roomId)).body.data.participants).toHaveLength(3)
  })

  it("a block across the sides hides THAT PAIR; the Blend goes on for everyone else (CR-I10, D-9)", async () => {
    const w = await blended("blk")
    const [a1, a2] = w.a
    const [b1, b2] = w.b
    const blockedOne = await sockets.online(b2)
    expect(await sockets.joins(blockedOne, w.roomId)).toBe(true)
    const listener = await sockets.online(b1)
    expect(await sockets.joins(listener, w.roomId)).toBe(true)
    // a2 blocks b2 — neither in the conversation so far.
    expect((await api.block(a2, b2.id)).status).toBe(200)

    // The Blend stays open; the pair is out of it, live and on every read.
    expect((await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })).closed_at).toBeNull()
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("active")
    expect(await until(async () => !(await sockets.inRoom(w.roomId, b2.id)))).toBe(true)
    for (const p of [a2, b2]) {
      expect(await canJoinChat(p.id, w.roomId)).toBe(false)
      expect((await api.send(p, w.roomId)).status).toBe(403)
    }
    // Everyone else keeps the room: a1 writes, b1 hears it live, b2 does not.
    expect(await sockets.inRoom(w.roomId, b1.id)).toBe(true)
    expect((await api.send(a1, w.roomId, "still here")).status).toBe(201)
    expect(await until(() => listener.heard.message.some((m) => m.message.content === "still here"))).toBe(true)
    expect(blockedOne.heard.message.some((m) => m.message.content === "still here")).toBe(false)
    for (const p of [a1, b1]) expect(await canJoinChat(p.id, w.roomId)).toBe(true)
    // Neither of the pair lists it; everyone else's roster goes on without them.
    expect((await api.blends(a2)).body.data.blends.map((b: { blendId: string }) => b.blendId)).not.toContain(w.blendId)
    expect((await api.roster(a1, w.roomId)).body.data.participants).toHaveLength(2)
  })

  it("blocks somebody by the handle a Blend showed — for the Blend's own people only", async () => {
    const w = await blended("hblk")
    const [a1] = w.a
    const [b1] = w.b
    const line = (await api.roster(a1, w.roomId)).body.data.participants.find((p: { name: string }) => p.name === w.pseudonyms.get(b1.id))
    expect(line.userId).toMatch(/^rh_/)
    // A stranger holding the same handle names nobody.
    const stranger = await person("hblk-stranger")
    expect((await api.block(stranger, line.userId)).status).toBe(404)
    expect(await db.blocked_users.count({ where: { blocker_id: stranger.id } })).toBe(0)
    // a1, in the Blend, blocks b1 by it.
    expect((await api.block(a1, line.userId)).status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: a1.id, blocked_id: b1.id } })).toBe(1)
  })

  it("closes twelve hours after its occurrence ends: the sweeper archives it and nobody gets back in (CR-I13, CR-K04)", async () => {
    const w = await blended("clock")
    await db.blends.update({ where: { id: w.blendId }, data: { closes_at: new Date(Date.now() - 60_000) } })
    // The door is the clock, before any sweep.
    expect(await canJoinChat(w.a[0].id, w.roomId)).toBe(false)
    await sweepExpiredChats()
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("archived")
    // Closed on its clock, so the open-only index no longer holds it.
    expect((await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })).closed_at).toBeInstanceOf(Date)
    // One Blend per pair per occurrence: liking again finds the closed one and answers null.
    const again = await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)
    expect(again.body.data).toEqual({ liked: true, blend: null })
    expect(await db.chat_group_members.count({ where: { chat_group_id: w.roomId, status: "active" } })).toBe(0)
    expect((await api.send(w.a[0], w.roomId)).status).toBe(403)
    expect((await api.blends(w.a[0])).body.data.blends.map((b: { blendId: string }) => b.blendId)).not.toContain(w.blendId)
  })

  it("a suspended member drops out of the Blend", async () => {
    const w = await blended("susp")
    await db.user.update({ where: { id: w.b[1].id }, data: { suspended_at: new Date() } })
    expect(await canJoinChat(w.b[1].id, w.roomId)).toBe(false)
    expect((await api.roster(w.a[0], w.roomId)).body.data.participants).toHaveLength(3)
  })
})

describe("a friend between the crews", () => {
  it("two crews sharing a member are not two sides", async () => {
    const host = await person("shared-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [x, y, z, both] = await Promise.all(["x", "y", "z", "both"].map((l) => person(`shared-${l}`)))
    const X = await crewOf(x, [both], "X crew")
    await befriend(y, z)
    const Y = await crewOf(y, [z, both], "Y crew")
    for (const p of [x, y, z, both]) await arrive(eventId, occurrenceId, p, testId("Heron"))
    expect((await api.likeCrew(x, eventId, Y.crewId, X.crewId)).status).toBe(404)
  })
})


/* -------------------------------------------------------------------------- */
/* Review round (PR #631): C1–C7 and the MUSTs                                 */
/* -------------------------------------------------------------------------- */

async function blendedPair(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const [a1, a2, a3] = await Promise.all(["a1", "a2", "a3"].map((l) => person(`${label}-${l}`, `Ananya ${l} Bhat`)))
  const [b1, b2] = await Promise.all(["b1", "b2"].map((l) => person(`${label}-${l}`, `Vikram ${l} Shetty`)))
  const A = await crewOf(a1, [a2, a3], "Crew Two")
  const B = await crewOf(b1, [b2], "Crew Five")
  for (const p of [a1, a2, a3, b1, b2]) await arrive(eventId, occurrenceId, p)
  await api.likeCrew(a1, eventId, B.crewId, A.crewId)
  const back = await api.likeCrew(b1, eventId, A.crewId, B.crewId)
  return {
    eventId,
    occurrenceId,
    A,
    B,
    a: [a1, a2, a3] as Person[],
    b: [b1, b2] as Person[],
    roomId: back.body.data.blend.chatGroupId as string,
    blendId: back.body.data.blend.blendId as string,
  }
}

describe("the host's switch, the person's opt-in, and size counted on active members", () => {
  it("refuses every crew like at an event whose host turned crews off (403)", async () => {
    const w = await twoCrews("off")
    await db.events.update({ where: { id: w.eventId }, data: { crews_enabled: false } })
    expect((await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)).status).toBe(403)
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })

  it("a person who turns the opt-in off between two likes makes no Blend, and is told nothing different", async () => {
    const host = await person("opt-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const solo = await person("opt-solo")
    const crew = await Promise.all(["c0", "c1"].map((l) => person(`opt-${l}`)))
    const C = await crewOf(crew[0], [crew[1]], "Room For One")
    await db.crews.update({ where: { id: C.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    for (const p of [solo, ...crew]) await arrive(eventId, occurrenceId, p)
    expect((await api.prefs(solo, eventId, { openToCrews: true })).body.data.openToCrews).toBe(true)
    // The opt-in lasts until the end of the night they said it.
    const until_ = await db.event_match_preferences.findUniqueOrThrow({
      where: { event_id_user_id: { event_id: eventId, user_id: solo.id } },
      select: { open_to_crews_until: true },
    })
    const occurrence = await db.event_occurrences.findUniqueOrThrow({ where: { id: occurrenceId }, select: { end_time: true } })
    expect(until_.open_to_crews_until?.getTime()).toBe(occurrence.end_time.getTime())
    expect((await api.likeCrew(solo, eventId, C.crewId)).body.data).toEqual({ liked: true, blend: null })
    expect((await api.prefs(solo, eventId, { openToCrews: false })).body.data.openToCrews).toBe(false)
    const back = await api.likePerson(crew[0], eventId, roomHandle(eventId, solo.id), C.crewId)
    expect(back).toEqual({ status: 200, body: expect.objectContaining({ data: { liked: true, blend: null } }) })
    expect(await db.blends.count({ where: { occurrence_id: occurrenceId } })).toBe(0)
  })

  it("a crew of seven with one suspended is six, and may meet one person; seven active may not (via HTTP)", async () => {
    const host = await person("sz-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const solo = await person("sz-solo")
    const crew = await Promise.all(Array.from({ length: 7 }, (_, i) => person(`sz-${i}`)))
    const C = await crewOf(crew[0], crew.slice(1), "Seven")
    await db.crews.update({ where: { id: C.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    for (const p of [solo, crew[0], crew[1]]) await arrive(eventId, occurrenceId, p)
    await api.prefs(solo, eventId, { openToCrews: true })
    expect((await api.likeCrew(solo, eventId, C.crewId)).status).toBe(404)
    await db.user.update({ where: { id: crew[6].id }, data: { suspended_at: new Date() } })
    expect((await api.likeCrew(solo, eventId, C.crewId)).body.data).toEqual({ liked: true, blend: null })
  })
})

describe("a crew that ends, or is hidden, takes its Blends with it", () => {
  it("dissolving a side closes its open Blend, archives the room and takes everyone's sockets out", async () => {
    const w = await blendedPair("dis")
    const listener = await sockets.online(w.a[0])
    expect(await sockets.joins(listener, w.roomId)).toBe(true)
    // Crew Five is two: one leaving dissolves it.
    expect((await api.remove(w.b[1], w.B.crewId, w.b[1].id)).body.data).toEqual({ dissolved: true })
    expect((await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })).closed_at).toBeInstanceOf(Date)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("archived")
    expect(await until(async () => !(await sockets.inRoom(w.roomId, w.a[0].id)))).toBe(true)
    expect(await canJoinChat(w.a[0].id, w.roomId)).toBe(false)
  })

  it("a moderator hiding a side closes its Blend at once, and the hidden crew can be liked by nobody", async () => {
    const w = await blendedPair("hide")
    const listener = await sockets.online(w.b[0])
    expect(await sockets.joins(listener, w.roomId)).toBe(true)
    const report = await db.message_reports.create({
      data: { reporter_id: w.b[1].id, message_id: w.A.crewId, message_type: "crew", reason: "offensive", excerpt: "Crew Two" },
      select: { id: true },
    })
    const admin = await person("hide-admin")
    await db.user.update({ where: { id: admin.id }, data: { role: "app_admin" } })
    session = { user: { id: admin.id, role: "app_admin" } }
    await resolveReport("message", report.id, "hide_crew")
    session = null
    expect((await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })).closed_at).toBeInstanceOf(Date)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("archived")
    expect(await until(async () => !(await sockets.inRoom(w.roomId, w.b[0].id)))).toBe(true)
    // Hidden: not here for anybody's like, though its members keep their crew.
    expect((await api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId)).status).toBe(404)
    expect((await api.detail(w.a[0], w.A.crewId)).status).toBe(200)
    await db.audit_logs.deleteMany({ where: { user_id: admin.id } })
  })

  it("a side hidden without its close landing still ends the Blend for everyone (the door reads hidden_at)", async () => {
    const w = await blendedPair("hid2")
    await db.crews.update({ where: { id: w.B.crewId }, data: { hidden_at: new Date() } })
    for (const p of [w.a[0], w.b[0]]) expect(await canJoinChat(p.id, w.roomId)).toBe(false)
    expect((await api.send(w.a[0], w.roomId)).status).toBe(403)
  })

  it("a member who leaves their crew leaves its Blends: out live, refused after", async () => {
    const w = await blendedPair("lv")
    const leaver = await sockets.online(w.a[2])
    expect(await sockets.joins(leaver, w.roomId)).toBe(true)
    expect((await api.remove(w.a[2], w.A.crewId, w.a[2].id)).body.data).toEqual({ dissolved: false })
    expect(await until(async () => !(await sockets.inRoom(w.roomId, w.a[2].id)))).toBe(true)
    expect(await canJoinChat(w.a[2].id, w.roomId)).toBe(false)
    expect(await canJoinChat(w.a[0].id, w.roomId)).toBe(true)
  })

  it("an erased member is out of the Blend; it goes on for the rest", async () => {
    const w = await blendedPair("er")
    const gone = await sockets.online(w.a[2])
    expect(await sockets.joins(gone, w.roomId)).toBe(true)
    await api.reveal(w.a[2], w.blendId)
    expect((await api.erase(w.a[2])).status).toBe(200)
    expect(await until(async () => !(await sockets.inRoom(w.roomId, w.a[2].id)))).toBe(true)
    expect(await db.blend_reveals.count({ where: { user_id: w.a[2].id } })).toBe(0)
    expect((await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })).closed_at).toBeNull()
    expect((await api.send(w.b[0], w.roomId, "after the erasure")).status).toBe(201)
    expect(await canJoinChat(w.a[0].id, w.roomId)).toBe(true)
  })
})

describe("the Blend's people, as each viewer sees them (C4)", () => {
  it("never lists somebody kept apart from the viewer, nor anybody who turned show-online off", async () => {
    const w = await blendedPair("c4")
    const [a1, a2] = w.a
    const [b1, b2] = w.b
    // Each side as [mine, count, how many people listed]: their side person by
    // person, your own as you and a count (step 9 review, H3).
    const sides = async (viewer: Person) =>
      ((await api.blends(viewer)).body.data.blends.find((b: { blendId: string }) => b.blendId === w.blendId)?.sides ?? []).map(
        (s: { crewId: string; mine: boolean; count: number; people: unknown[] }) => [s.crewId, s.mine, s.count, s.people.length]
      )
    const before = await sides(a1)
    expect(before).toHaveLength(2)
    expect(before).toEqual(expect.arrayContaining([[w.A.crewId, true, 3, 1], [w.B.crewId, false, 2, 2]]))
    // a2 turns "show online" off: off everyone's list and count but their own.
    await db.profiles.update({ where: { id: a2.id }, data: { show_online: false } })
    expect(await sides(b1)).toContainEqual([w.A.crewId, false, 2, 2])
    expect(await sides(a1)).toContainEqual([w.A.crewId, true, 2, 1])
    expect(await sides(a2)).toContainEqual([w.A.crewId, true, 3, 1])
    // A block inside a side (a crewmate) hides the pair from each other, nobody else.
    await db.blocked_users.create({ data: { blocker_id: b1.id, blocked_id: b2.id } })
    expect(await sides(b1)).toContainEqual([w.B.crewId, true, 1, 1])
    expect(await sides(a1)).toContainEqual([w.B.crewId, false, 2, 2])
  })
})

describe("crew and Blend rooms in the chat list (step 9 review, S5)", () => {
  type ListedRoom = { id: string; kind: string; crewId: string | null; blendId: string | null; closesAt: string | null; lastMessageAt: string | null; unreadCount: number; lastMessage: { content: string; user: { id: string; name: string } } | null }
  const rooms = async (p: Person): Promise<ListedRoom[]> => {
    const res = await api.chatGroups(p)
    expect(res.status).toBe(200)
    // Every row of `groups` is an event's room and says so; crews' and Blends' are their own list.
    expect(res.body.data.groups.every((g: { kind: string }) => g.kind === "event")).toBe(true)
    return res.body.data.rooms
  }
  const pick = (list: ListedRoom[], id: string) => list.find((r) => r.id === id)
  const call2 = (p: Person) => api.chatGroups(p, 2)

  it("lists a member's crew chat and open Blend with their kind — not the Blend to a pair a block parted, nor once it closes", async () => {
    const w = await blendedPair("cl")
    const [a1, a2] = w.a
    const [b1, b2] = w.b
    const mine = await rooms(a1)
    expect(pick(mine, w.A.roomId)).toMatchObject({ kind: "crew", crewId: w.A.crewId, blendId: null, closesAt: null })
    expect(pick(mine, w.roomId)).toMatchObject({ kind: "blend", crewId: null, blendId: w.blendId, closesAt: expect.any(String) })
    expect(pick(mine, w.B.roomId)).toBeUndefined()
    expect(await rooms(await person("cl-stranger"))).toEqual([])

    // Its last line, named as the room names people: the Blend's handle and pseudonym, as its history has them.
    expect((await api.send(a1, w.roomId, "list me")).status).toBe(201)
    const line = (await api.read(b1, w.roomId)).body.data.messages.find((m: { content: string }) => m.content === "list me")
    expect(pick(await rooms(b1), w.roomId)?.lastMessage).toMatchObject({ content: "list me", user: { id: line.user.id, name: line.user.name } })
    expect(line.user.id).toMatch(/^rh_/)

    // A block across the sides: the pair do not list the Blend; everyone else does, and the crew chats stay.
    expect((await api.block(a2, b2.id)).status).toBe(200)
    expect(pick(await rooms(a2), w.roomId)).toBeUndefined()
    expect(pick(await rooms(b2), w.roomId)).toBeUndefined()
    expect(pick(await rooms(a2), w.A.roomId)).toBeDefined()
    expect(pick(await rooms(a1), w.roomId)).toBeDefined()

    // Not paged: the first page carries them, a later page none.
    const second = await call2(a1)
    expect(second.status).toBe(200)
    expect(second.body.data.rooms).toEqual([])

    // Its clock passes, sweeper or not: off every list.
    await db.blends.update({ where: { id: w.blendId }, data: { closes_at: new Date(Date.now() - 1000) } })
    const after = await rooms(a1)
    expect(pick(after, w.roomId)).toBeUndefined()
    expect(pick(after, w.A.roomId)).toBeDefined()
  })

  /** Crew Two (a3 not here) and Crew Five (b3 not here) in one Blend. */
  async function blendNow(label: string) {
    const w = await twoCrews(label)
    await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)
    const back = (await api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId)).body.data.blend
    const lists = async (p: Person, id: string) => pick(await rooms(p), id) !== undefined
    expect(await lists(w.a[0], back.chatGroupId)).toBe(true)
    return { ...w, roomId: back.chatGroupId as string, blendId: back.blendId as string, lists }
  }

  it("lists a Blend only to its snapshot: not to a crewmate who arrived after the match, nor to one who left it", async () => {
    const w = await blendNow("cl2")
    const [, a2, a3] = w.a
    await arrive(w.eventId, w.occurrenceId, a3)
    expect(await w.lists(a3, w.roomId)).toBe(false)
    expect(await w.lists(a3, w.A.roomId)).toBe(true)
    expect((await api.leave(a2, w.roomId)).status).toBe(200)
    expect(await w.lists(a2, w.roomId)).toBe(false)
    expect(await w.lists(a2, w.A.roomId)).toBe(true)
  })

  it("does not list a Blend to a pair kept apart across it by a closed conversation; the rest still list it", async () => {
    const w = await blendNow("cl3")
    const [a1] = w.a
    const [b1, b2] = w.b
    const [user1_id, user2_id] = conversationPair(a1.id, b2.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: a1.id, closed_reason: "unmatch" } })
    expect(await w.lists(a1, w.roomId)).toBe(false)
    expect(await w.lists(b2, w.roomId)).toBe(false)
    expect(await w.lists(b1, w.roomId)).toBe(true)
  })

  it("drops a Blend whose side a moderator hid, for everyone; the hidden crew keeps its own chat (C12), as its door does", async () => {
    const w = await blendNow("cl4")
    await db.crews.update({ where: { id: w.B.crewId }, data: { hidden_at: new Date() } })
    expect(await w.lists(w.a[0], w.roomId)).toBe(false)
    expect(await w.lists(w.b[0], w.roomId)).toBe(false)
    expect(await w.lists(w.b[0], w.B.roomId)).toBe(true)
    expect((await api.read(w.b[0], w.B.roomId)).status).toBe(200)
  })

  it("drops a Blend closed early whose room the sweeper has not archived yet", async () => {
    const w = await blendNow("cl5")
    await db.blends.update({ where: { id: w.blendId }, data: { closed_at: new Date() } })
    expect(await w.lists(w.a[0], w.roomId)).toBe(false)
    expect(await w.lists(w.b[0], w.roomId)).toBe(false)
  })

  it("drops a crew chat to somebody no longer in the crew, and a dissolved crew's chat before its room is archived", async () => {
    const w = await blendNow("cl6")
    const [a1] = w.a
    const [b1, , b3] = w.b
    // A settle that failed after the member row went: the chat row is still active.
    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: w.B.crewId, user_id: b3.id } } })
    expect(await w.lists(b3, w.B.roomId)).toBe(false)
    expect(await w.lists(b1, w.B.roomId)).toBe(true)
    await db.crews.update({ where: { id: w.A.crewId }, data: { dissolved_at: new Date() } })
    expect(await w.lists(a1, w.A.roomId)).toBe(false)
    expect(await w.lists(a1, w.roomId)).toBe(false)
  })

  it("never previews, counts or dates a line from somebody in a block with the viewer, in a crew chat or an event's room", async () => {
    const owner = await person("cl3-owner", "Meera Iyer")
    const x = await person("cl3-x", "Xavier Dsouza")
    const y = await person("cl3-y", "Yamini Rao")
    const C = await crewOf(owner, [x, y], "Quiet Lot")
    expect((await api.send(owner, C.roomId, "owner first")).status).toBe(201)
    await new Promise((r) => setTimeout(r, 5))
    expect((await api.send(y, C.roomId, "y later")).status).toBe(201)
    await db.blocked_users.create({ data: { blocker_id: x.id, blocked_id: y.id } })
    const first = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: C.roomId, content: "owner first" }, select: { id: true, created_at: true } })
    const visibleToX = await db.chat_messages.count({ where: { chat_group_id: C.roomId, deleted_at: null, user_id: { not: y.id } } })
    const all = await db.chat_messages.count({ where: { chat_group_id: C.roomId, deleted_at: null } })

    // Never read: the count of what x's history would show; the preview and its time are the owner's line.
    const xs = pick(await rooms(x), C.roomId)!
    expect(xs.lastMessage).toMatchObject({ content: "owner first", user: { name: "Meera" } })
    expect(new Date(xs.lastMessageAt!).getTime()).toBe(first.created_at.getTime())
    expect(xs.unreadCount).toBe(visibleToX)
    expect(visibleToX).toBeLessThan(all)
    // The owner, in no block, sees y's line.
    const os = pick(await rooms(owner), C.roomId)!
    expect(os.lastMessage).toMatchObject({ content: "y later", user: { name: "Yamini" } })
    // Their own line is never unread to them.
    expect(os.unreadCount).toBe(await db.chat_messages.count({ where: { chat_group_id: C.roomId, deleted_at: null, user_id: { not: owner.id } } }))
    expect(os.unreadCount).toBeLessThan(all)

    // Read up to the owner's line: y's lines after it are not unread for x, the owner's next one is.
    await db.chat_group_members.update({ where: { chat_group_id_user_id: { chat_group_id: C.roomId, user_id: x.id } }, data: { last_read_message_id: first.id } })
    expect((await api.send(y, C.roomId, "y again")).status).toBe(201)
    expect(pick(await rooms(x), C.roomId)!.unreadCount).toBe(0)
    expect((await api.send(owner, C.roomId, "owner again")).status).toBe(201)
    expect(pick(await rooms(x), C.roomId)!.unreadCount).toBe(1)

    // Reading the room's newest page marks it read: the row counts nothing until the next line.
    expect((await api.read(x, C.roomId)).status).toBe(200)
    expect(pick(await rooms(x), C.roomId)!.unreadCount).toBe(0)
    expect((await api.send(owner, C.roomId, "owner once more")).status).toBe(201)
    expect(pick(await rooms(x), C.roomId)!.unreadCount).toBe(1)

    // An event's room, the same: a blocked person's line is neither the preview nor counted.
    const host = await person("cl3-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    for (const p of [x, y]) await arrive(eventId, occurrenceId, p)
    const eventRoom = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })).id
    expect((await api.send(y, eventRoom, "y in the room")).status).toBe(201)
    const groups = (await api.chatGroups(x)).body.data.groups as { id: string; unreadCount: number; lastMessage: unknown }[]
    const row = groups.find((g) => g.id === eventRoom)!
    expect(row.lastMessage).toBeNull()
    expect(row.unreadCount).toBe(0)
  })
})

describe("crew likes that never made a Blend go after their night (MUST)", () => {
  it("purges a lapsed like 12 hours after the occurrence ends, and keeps one that made a Blend", async () => {
    const w = await blendedPair("pg")
    const [c1, c2] = await Promise.all(["c1", "c2"].map((l) => person(`pg-${l}`)))
    const C = await crewOf(c1, [c2], "Crew Nine")
    for (const p of [c1, c2]) await arrive(w.eventId, w.occurrenceId, p)
    // Crew Two likes Crew Nine, which never likes back.
    await api.likeCrew(w.a[0], w.eventId, C.crewId, w.A.crewId)
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(3)
    // Not yet: the night is not 12 hours over.
    await purgeLapsedCrewLikes()
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(3)
    await db.event_occurrences.update({ where: { id: w.occurrenceId }, data: { end_time: new Date(Date.now() - 13 * 60 * 60 * 1000) } })
    await purgeLapsedCrewLikes()
    const left = await db.crew_likes.findMany({ where: { occurrence_id: w.occurrenceId }, select: { to_crew_id: true } })
    expect(left.map((l) => l.to_crew_id).sort()).toEqual([w.A.crewId, w.B.crewId].sort())
  })
})
