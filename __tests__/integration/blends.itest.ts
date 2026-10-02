/*
 * Crew matching, Blends and the crew reveal, end to end on a migrate-deploy
 * database (step 8: TQ-A12 CR-I06..I10, CR-G03 at the API; TQ-X07 CR-I11/I12,
 * SEC-03/04/06; TQ-B06 CR-I13/CR-K04; TQ-S07 CR-K03, CR-I14, CR-K06).
 * Real routes, real rows, the real socket server.
 *
 * The mutations each block is written against are in negative-controls.json.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-blends-secret-of-32-characters-xxxxx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { canJoinChat } from "@/lib/socket-auth"
import { roomHandle } from "@/lib/room-handle"
import { db, testId } from "./helpers"
import { api, arrive, befriend, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, until } from "./crew-world"

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

    // A late arrival walks in (CR-K03's other half): a3 checks in.
    await arrive(w.eventId, w.occurrenceId, a3)
    expect(await canJoinChat(a3.id, roomId)).toBe(true)
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
    // The crew's line names the person by tonight's pseudonym, never their name.
    const line = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: w.C.roomId, type: "system" }, select: { content: true } })
    expect(line.content).toBe(`liked ${w.soloPseudonym} for the crew`)
  })

  it("refuses each guardrail: a crew without room for one more, a crew of seven, dating one-sided, a person who did not opt in", async () => {
    const closed = await soloWorld("g1")
    await db.crews.update({ where: { id: closed.C.crewId }, data: { open_to_solo: false } })
    await api.prefs(closed.solo, closed.eventId, { openToCrews: true })
    expect((await api.likeCrew(closed.solo, closed.eventId, closed.C.crewId)).status).toBe(404)
    expect((await api.likePerson(closed.crew[0], closed.eventId, roomHandle(closed.eventId, closed.solo.id), closed.C.crewId)).status).toBe(403)

    const big = await soloWorld("g2", { crewSize: 7 })
    await api.prefs(big.solo, big.eventId, { openToCrews: true })
    expect((await api.likeCrew(big.solo, big.eventId, big.C.crewId)).status).toBe(404)
    expect((await api.likePerson(big.crew[0], big.eventId, roomHandle(big.eventId, big.solo.id), big.C.crewId)).status).toBe(403)

    const dating = await soloWorld("g3", { crewIntent: ["dating"] })
    await api.prefs(dating.solo, dating.eventId, { openToCrews: true, intent: ["friendship"] })
    expect((await api.likeCrew(dating.solo, dating.eventId, dating.C.crewId)).status).toBe(404)
    expect((await api.likePerson(dating.crew[0], dating.eventId, roomHandle(dating.eventId, dating.solo.id), dating.C.crewId)).status).toBe(404)
    // Both chose it: allowed.
    await api.prefs(dating.solo, dating.eventId, { intent: ["dating"] })
    expect((await api.likeCrew(dating.solo, dating.eventId, dating.C.crewId)).status).toBe(200)

    const shy = await soloWorld("g4")
    expect((await api.likePerson(shy.crew[0], shy.eventId, roomHandle(shy.eventId, shy.solo.id), shy.C.crewId)).status).toBe(404)
    expect(await db.crew_likes.count({ where: { occurrence_id: { in: [closed.occurrenceId, big.occurrenceId, shy.occurrenceId] } } })).toBe(0)
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

  it("one tap reveals the crew — everyone who consented, never somebody keeping themselves anonymous (CR-I11, D-10)", async () => {
    const w = await blended("rev")
    const [a1, a2] = w.a
    const [b1] = w.b
    // a2 keeps themselves anonymous.
    expect((await api.settings(a2, w.A.crewId, true)).status).toBe(200)

    const tap = await api.reveal(a1, w.A.crewId, w.eventId)
    expect(tap.status).toBe(200)
    expect(tap.body.data).toEqual({ revealed: 1, keptPrivate: 1 })
    const prefs = await db.event_match_preferences.findMany({ where: { event_id: w.eventId, revealed: true }, select: { user_id: true } })
    expect(prefs.map((p) => p.user_id)).toEqual([a1.id])

    // The other side sees a1's first name — never the full one — and a2 as a pseudonym.
    const seen = (await api.blends(b1)).body.data.blends.find((b: { blendId: string }) => b.blendId === w.blendId)
    const side = seen.sides.find((s: { crewId: string }) => s.crewId === w.A.crewId)
    expect(side).toMatchObject({ revealed: 1, keptPrivate: 1 })
    const byPseudonym = new Map(side.people.map((p: { pseudonym: string; name: string | null }) => [p.pseudonym, p.name]))
    expect(byPseudonym.get(w.pseudonyms.get(a1.id))).toBe("Ananya")
    expect(byPseudonym.get(w.pseudonyms.get(a2.id))).toBeNull()
    expect(JSON.stringify(seen)).not.toMatch(/a2 Bhat|Bhat/)
    // Nowhere else either: no bell row carries a name.
    const rows = await db.notifications.findMany({ where: { user_id: { in: [b1.id, w.b[1].id] } }, select: { title: true, body: true } })
    expect(rows.every((r) => !/Ananya|Bhat/.test(`${r.title} ${r.body}`))).toBe(true)

    // D-10: switching it on after a reveal applies from then on — a1's stays.
    await api.settings(a1, w.A.crewId, true)
    await api.reveal(a2, w.A.crewId, w.eventId)
    expect(await db.event_match_preferences.count({ where: { event_id: w.eventId, user_id: a1.id, revealed: true } })).toBe(1)
    expect(await db.event_match_preferences.count({ where: { event_id: w.eventId, user_id: a2.id, revealed: true } })).toBe(0)
  })

  it("anyone can leave alone; the room stays for the rest (CR-I14)", async () => {
    const w = await blended("leave")
    expect((await api.leave(w.a[1], w.roomId)).status).toBe(200)
    expect((await api.read(w.a[1], w.roomId)).status).toBe(403)
    expect((await api.read(w.a[0], w.roomId)).status).toBe(200)
    expect((await api.roster(w.b[0], w.roomId)).body.data.participants).toHaveLength(3)
  })

  it("a block between any member of one side and any of the other closes the Blend and empties its room (CR-I10)", async () => {
    const w = await blended("blk")
    const listener = await sockets.online(w.b[0])
    expect(await sockets.joins(listener, w.roomId)).toBe(true)
    // a2 blocks b2 — neither in the conversation so far.
    expect((await api.block(w.a[1], w.b[1].id)).status).toBe(200)
    const blend = await db.blends.findUniqueOrThrow({ where: { id: w.blendId }, select: { closed_at: true } })
    expect(blend.closed_at).toBeInstanceOf(Date)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("archived")
    expect(await until(async () => !(await sockets.inRoom(w.roomId, w.b[0].id)))).toBe(true)
    for (const p of [...w.a.slice(0, 2), ...w.b.slice(0, 2)]) expect(await canJoinChat(p.id, w.roomId)).toBe(false)
    expect((await api.send(w.a[0], w.roomId)).status).toBe(403)
    // And the crews no longer see each other, nor can they like again.
    expect((await api.atEvent(w.a[0], w.eventId)).body.data.crews.map((c: { crewId: string }) => c.crewId)).not.toContain(w.B.crewId)
  })

  it("closes twelve hours after its occurrence ends: the sweeper archives it and nobody gets back in (CR-I13, CR-K04)", async () => {
    const w = await blended("clock")
    await db.blends.update({ where: { id: w.blendId }, data: { closes_at: new Date(Date.now() - 60_000) } })
    // The door is the clock, before any sweep.
    expect(await canJoinChat(w.a[0].id, w.roomId)).toBe(false)
    await sweepExpiredChats()
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: w.roomId }, select: { status: true } })).status).toBe("archived")
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

