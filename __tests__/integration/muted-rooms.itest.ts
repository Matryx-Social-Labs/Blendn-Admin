/*
 * The rooms you silenced: `GET /me/muted-rooms` and the `mutedRooms` count on
 * `GET /me/notification-preferences` (Settings › Notifications › Muted rooms).
 * Real routes and rows on a migrate-deploy database. The mutations each block
 * is written against are in negative-controls.json.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { Prisma } from "@prisma/client"
import { mutedNowSql } from "@/lib/room-mute"
import { MUTED_ROOMS_COUNT_CAP, mutedRoomCount, mutedRoomPage } from "@/lib/muted-rooms"
import { api, call, cleanupCrewWorld, crewOf, liveEvent, person, arrive, type Person } from "./crew-world"
import { db } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const muted = require("@/app/api/mobile/me/muted-rooms/route") as typeof import("@/app/api/mobile/me/muted-rooms/route")
const prefs = require("@/app/api/mobile/me/notification-preferences/route") as typeof import("@/app/api/mobile/me/notification-preferences/route")
const muteRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route")
/* eslint-enable @typescript-eslint/no-require-imports */

afterAll(async () => {
  await cleanupCrewWorld()
})

type Row = { id: string; kind: string; mute: { muted: boolean; until: string | null }; lastMessage: { content: string } | null; unreadCount: number }
const list = async (as: Person, query = "") => {
  const res = await call(muted.GET, `/api/mobile/me/muted-rooms${query}`, as)
  return { status: res.status, ...(res.body.data ?? {}), error: res.body } as { status: number; rooms: Row[]; nextCursor: string | null; pagination: { limit: number; hasMore: boolean }; error: unknown }
}
const ids = (rooms: { id: string }[]) => rooms.map((r) => r.id)
const mutedCount = async (as: Person) => (await call(prefs.GET, "/api/mobile/me/notification-preferences", as)).body.data.mutedRooms as number
const muteViaRoute = (as: Person, roomId: string, until?: string) =>
  call(muteRoute.POST, `/api/mobile/chat/groups/${roomId}/mute`, as, { method: "POST", body: until ? { until } : {}, params: { chatGroupId: roomId } })

/** An event room `me` is in, with the member and room states asked for. `prefs` is the raw column. */
async function eventRoom(
  host: Person,
  me: Person,
  opts: { member?: "active" | "muted" | "banned" | "left"; room?: "active" | "locked" | "archived"; prefs?: Prisma.InputJsonValue; updatedAt?: Date; eventStatus?: "draft" | "published" } = {}
) {
  const { eventId } = await liveEvent(host.id)
  if (opts.eventStatus) await db.events.update({ where: { id: eventId }, data: { status: opts.eventStatus } })
  const room = await db.chat_groups.update({ where: { event_id: eventId }, data: { status: opts.room ?? "active" }, select: { id: true } })
  await db.chat_group_members.create({
    data: {
      chat_group_id: room.id,
      user_id: me.id,
      status: opts.member ?? "active",
      anonymous_name: `Otter ${room.id.slice(0, 8)}`,
      notification_preferences: opts.prefs ?? {},
      ...(opts.updatedAt && { updated_at: opts.updatedAt }),
    },
  })
  return { eventId, roomId: room.id }
}
const MUTED = { muted: true, muted_until: null }

describe("GET /me/muted-rooms: which rooms", () => {
  it("lists the rooms you muted, newest mute first, each as the chat list's own row", async () => {
    const host = await person("mr-host")
    const me = await person("mr-me")
    const first = await eventRoom(host, me)
    const second = await eventRoom(host, me)
    await eventRoom(host, me) // never muted
    const in2h = new Date(Date.now() + 2 * 3600_000).toISOString()
    expect((await muteViaRoute(me, first.roomId, in2h)).status).toBe(200)
    expect((await muteViaRoute(me, second.roomId)).status).toBe(200)

    const answer = await list(me)
    expect(answer.status).toBe(200)
    expect(ids(answer.rooms)).toEqual([second.roomId, first.roomId])
    expect(answer.rooms[0]).toMatchObject({ kind: "event", mute: { muted: true, until: null } })
    expect(answer.rooms[1]).toMatchObject({ kind: "event", mute: { muted: true, until: in2h } })
    expect(answer.nextCursor).toBeNull()
    expect(answer.pagination).toEqual({ limit: 50, hasMore: false })

    // The same builder: a muted row IS that room's row in the chat list, field for field.
    const groups = (await api.chatGroups(me)).body.data.groups as { id: string }[]
    for (const row of answer.rooms) expect(row).toEqual(groups.find((g) => g.id === row.id))
  })

  it("leaves out a lapsed mute, `muted: false`, an unreadable time, a ban, a leave and an archived room", async () => {
    const host = await person("mr-out-host")
    const me = await person("mr-out")
    const kept = await eventRoom(host, me, { prefs: MUTED })
    const future = await eventRoom(host, me, { prefs: { muted: true, muted_until: new Date(Date.now() + 3600_000).toISOString() } })
    const gone = [
      await eventRoom(host, me, { prefs: { muted: true, muted_until: new Date(Date.now() - 1000).toISOString() } }),
      await eventRoom(host, me, { prefs: { muted: false, muted_until: null } }),
      await eventRoom(host, me, { prefs: { muted: true, muted_until: "not a time" } }),
      await eventRoom(host, me, { prefs: MUTED, member: "banned" }),
      await eventRoom(host, me, { prefs: MUTED, member: "left" }),
      await eventRoom(host, me, { prefs: MUTED, room: "archived" }),
      await eventRoom(host, me, { prefs: MUTED, eventStatus: "draft" }),
    ]
    const answer = await list(me)
    expect(new Set(ids(answer.rooms))).toEqual(new Set([kept.roomId, future.roomId]))
    for (const g of gone) expect(ids(answer.rooms)).not.toContain(g.roomId)
    // The organiser's mute (`status: muted`) is another thing and still lists a room the person silenced too.
    const both = await eventRoom(host, me, { prefs: MUTED, member: "muted" })
    expect(ids((await list(me)).rooms)).toContain(both.roomId)
    expect(await mutedCount(me)).toBe(3)
  })

  it("shows a muted room as the chat list would for this viewer: a blocked person's line is neither its preview nor unread", async () => {
    const host = await person("mr-blk-host")
    const me = await person("mr-blk")
    const noisy = await person("mr-blk-noisy")
    const { roomId } = await eventRoom(host, me, { prefs: MUTED })
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: noisy.id, anonymous_name: "Loud Heron" } })
    await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: noisy.id, content: "from the blocked one" } })
    expect((await list(me)).rooms[0]).toMatchObject({ id: roomId, unreadCount: 1, lastMessage: { content: "from the blocked one" } })
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: noisy.id } })
    expect((await list(me)).rooms[0]).toMatchObject({ id: roomId, unreadCount: 0, lastMessage: null })
  })
})

describe("GET /me/muted-rooms: a crew's or Blend's room follows its owner's door", () => {
  async function crewRoom(label: string) {
    const a = await person(`${label}-a`)
    const b = await person(`${label}-b`)
    const c = await person(`${label}-c`)
    const crew = await crewOf(a, [b, c], `Crew ${label}`)
    await db.chat_group_members.updateMany({ where: { chat_group_id: crew.roomId, user_id: b.id }, data: { notification_preferences: MUTED } })
    return { a, b, c, ...crew }
  }

  it("lists a muted crew chat as a crew row, and drops it when the crew is dissolved", async () => {
    const w = await crewRoom("mr-crew")
    const answer = await list(w.b)
    expect(answer.rooms).toHaveLength(1)
    expect(answer.rooms[0]).toMatchObject({ id: w.roomId, kind: "crew", crewId: w.crewId, mute: { muted: true } })
    expect(await mutedCount(w.b)).toBe(1)
    await db.crews.update({ where: { id: w.crewId }, data: { dissolved_at: new Date() } })
    expect((await list(w.b)).rooms).toEqual([])
    expect(await mutedCount(w.b)).toBe(0)
  })

  it("drops it for a person no longer in the crew, and for one who is suspended, though the member row stands", async () => {
    const w = await crewRoom("mr-door")
    expect(ids((await list(w.b)).rooms)).toEqual([w.roomId])
    await db.user.update({ where: { id: w.b.id }, data: { suspended_at: new Date() } })
    expect((await list(w.b)).rooms).toEqual([])
    await db.user.update({ where: { id: w.b.id }, data: { suspended_at: null } })
    expect(ids((await list(w.b)).rooms)).toEqual([w.roomId])
    await db.crew_members.deleteMany({ where: { crew_id: w.crewId, user_id: w.b.id } })
    expect((await list(w.b)).rooms).toEqual([])
    expect(await mutedCount(w.b)).toBe(0)
    // The others in the crew never muted it: nothing of theirs.
    expect((await list(w.c)).rooms).toEqual([])
  })

  it("lists a muted Blend as a blend row; a block across its sides takes it from that pair only, and a closed one from everybody", async () => {
    const host = await person("mr-bl-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a1, a2, a3] = await Promise.all(["a1", "a2", "a3"].map((l) => person(`mr-bl-${l}`)))
    const [b1, b2, b3] = await Promise.all(["b1", "b2", "b3"].map((l) => person(`mr-bl-${l}`)))
    const A = await crewOf(a1, [a2, a3], "Mute Crew A")
    const B = await crewOf(b1, [b2, b3], "Mute Crew B")
    for (const p of [a1, a2, b1, b2]) await arrive(eventId, occurrenceId, p)
    await api.likeCrew(a1, eventId, B.crewId, A.crewId)
    const blend = (await api.likeCrew(b1, eventId, A.crewId, B.crewId)).body.data.blend as { chatGroupId: string; blendId: string }
    for (const p of [a1, a2, b1]) {
      await db.chat_group_members.updateMany({ where: { chat_group_id: blend.chatGroupId, user_id: p.id }, data: { notification_preferences: MUTED } })
    }
    const blendRow = async (p: Person) => (await list(p)).rooms.find((r) => r.id === blend.chatGroupId)
    expect(await blendRow(a1)).toMatchObject({ kind: "blend", blendId: blend.blendId, mute: { muted: true } })

    expect((await api.block(a2, b2.id)).status).toBe(200)
    expect(await blendRow(a2)).toBeUndefined()
    expect(await blendRow(a1)).toBeDefined()
    expect(await mutedCount(a2)).toBe(0)
    expect(await mutedCount(a1)).toBe(1)

    await db.blends.update({ where: { id: blend.blendId }, data: { closes_at: new Date(Date.now() - 1000) } })
    await db.chat_groups.update({ where: { id: blend.chatGroupId }, data: { status: "archived" } })
    expect(await blendRow(a1)).toBeUndefined()
    expect(await blendRow(b1)).toBeUndefined()
  })
})

describe("GET /me/muted-rooms: paging", () => {
  const TIE = new Date("2026-10-01T10:00:00.000Z")

  it("breaks a tie on the room id, and never skips or repeats a row across pages", async () => {
    const host = await person("mr-page-host")
    const me = await person("mr-page")
    const rooms = []
    for (let i = 0; i < 5; i++) rooms.push(await eventRoom(host, me, { prefs: MUTED, updatedAt: TIE }))
    // Two rows a microsecond apart: a cursor that kept only milliseconds would repeat or skip one of them.
    const [newer, older] = [await eventRoom(host, me, { prefs: MUTED }), await eventRoom(host, me, { prefs: MUTED })]
    await db.$executeRaw`UPDATE chat_group_members SET updated_at = '2026-10-02 10:00:00.000002+00' WHERE chat_group_id = ${newer.roomId}::uuid AND user_id = ${me.id}`
    await db.$executeRaw`UPDATE chat_group_members SET updated_at = '2026-10-02 10:00:00.000001+00' WHERE chat_group_id = ${older.roomId}::uuid AND user_id = ${me.id}`

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await list(me, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`)
      expect(page.status).toBe(200)
      expect(page.rooms.length).toBeLessThanOrEqual(2)
      expect(page.pagination.hasMore).toBe(page.nextCursor !== null)
      seen.push(...ids(page.rooms))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)

    const tied = rooms.map((r) => r.roomId).sort()
    expect(seen).toEqual([newer.roomId, older.roomId, ...tied])
    expect(pages).toBe(4)
  })

  it("does not answer a short or empty page while listed rooms remain behind rooms that are not listed", async () => {
    const host = await person("mr-hole-host")
    const me = await person("mr-hole")
    const real = [await eventRoom(host, me, { prefs: MUTED, updatedAt: new Date("2026-09-01T10:00:00Z") }), await eventRoom(host, me, { prefs: MUTED, updatedAt: new Date("2026-09-01T09:00:00Z") })]
    // Newer than both, and none of them listed: a page of the first `limit` candidates would be empty.
    for (let i = 0; i < 4; i++) await eventRoom(host, me, { prefs: MUTED, room: "archived", updatedAt: new Date(`2026-09-02T10:0${i}:00Z`) })
    const first = await list(me, "?limit=2")
    expect(ids(first.rooms)).toEqual(real.map((r) => r.roomId))
    expect(first.nextCursor).toBeNull()
  })

  it("walks on to a later batch when the first is all unlisted, and answers a cursor when it has examined as many as it may", async () => {
    const host = await person("mr-walk-host")
    const me = await person("mr-walk")
    const listed = await eventRoom(host, me, { prefs: MUTED, updatedAt: new Date("2026-09-01T10:00:00Z") })
    for (let i = 0; i < 5; i++) await eventRoom(host, me, { prefs: MUTED, room: "archived", updatedAt: new Date(`2026-09-02T10:0${i}:00Z`) })

    // Batches of 2 over five unlisted rooms: the listed one is in the third batch and is still found.
    const found = await mutedRoomPage(me.id, 5, null, new Date(), { batch: 2, maxExamined: 100 })
    expect(ids(found.rooms)).toEqual([listed.roomId])
    expect(found.nextCursor).toBeNull()

    // Allowed to look at four, it answers nothing yet and says where to go on from; the cursor reaches the room.
    const short = await mutedRoomPage(me.id, 5, null, new Date(), { batch: 2, maxExamined: 4 })
    expect(short.rooms).toEqual([])
    expect(short.nextCursor).toEqual(expect.any(String))
    const rest = await list(me, `?cursor=${short.nextCursor}`)
    expect(ids(rest.rooms)).toEqual([listed.roomId])
  })

  it("answers 400 to a cursor it did not give, and defaults and clamps `limit`", async () => {
    const host = await person("mr-bad-host")
    const me = await person("mr-bad")
    const rooms = [await eventRoom(host, me, { prefs: MUTED }), await eventRoom(host, me, { prefs: MUTED })]
    const real = (await list(me, "?limit=1")).nextCursor as string
    expect(real).toEqual(expect.any(String))
    for (const bad of ["x", "not-base64!!", Buffer.from("a|b").toString("base64url"), Buffer.from("2026-10-01T10:00:00.000Z|nope").toString("base64url"), `${real}A`, encodeURIComponent("%%")]) {
      const res = await list(me, `?cursor=${bad}`)
      expect(res.status).toBe(400)
    }
    expect((await list(me, `?cursor=${real}`)).rooms).toHaveLength(1)
    expect((await list(me, "?limit=0")).rooms).toHaveLength(1) // 1 at least
    expect((await list(me, "?limit=abc")).pagination.limit).toBe(50)
    expect((await list(me, "?limit=1000")).pagination.limit).toBe(100)
    expect((await list(me)).rooms).toHaveLength(rooms.length)
  })

  it("answers 401 without a token", async () => {
    const res = await muted.GET(new (require("next/server").NextRequest)("http://localhost/api/mobile/me/muted-rooms"))
    expect(res.status).toBe(401)
  })
})

describe("the `mutedRooms` count", () => {
  it("is 0 for nobody muted, counts what the list shows, and moves with a mute and an unmute", async () => {
    const host = await person("mc-host")
    const me = await person("mc-me")
    expect(await mutedCount(me)).toBe(0)
    const a = await eventRoom(host, me)
    await eventRoom(host, me)
    expect((await muteViaRoute(me, a.roomId)).status).toBe(200)
    expect(await mutedCount(me)).toBe(1)
    await eventRoom(host, me, { prefs: MUTED, room: "archived" })
    expect(await mutedCount(me)).toBe(1)
    const body = (await call(prefs.GET, "/api/mobile/me/notification-preferences", me)).body.data
    expect(body).toEqual({ matches: true, crew: true, night: true, mutedRooms: 1 })
    expect(await mutedCount(me)).toBe((await list(me)).rooms.length)
  })

  it("stops at 1000, and counts only that far", async () => {
    expect(MUTED_ROOMS_COUNT_CAP).toBe(1000) // written out: the app says "999+" past it
    const host = await person("mc-cap-host")
    const me = await person("mc-cap")
    for (let i = 0; i < 5; i++) await eventRoom(host, me, { prefs: MUTED })
    expect(await mutedRoomCount(me.id)).toBe(5)
    expect(await mutedRoomCount(me.id, new Date(), 3)).toBe(3)
  })
})

describe("the partial index", () => {
  it("exists, is valid, and the muted read is answered by it", async () => {
    const [index] = await db.$queryRaw<{ ok: boolean; def: string }[]>`
      SELECT i.indisvalid AS ok, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'chat_group_members_muted_idx'`
    expect(index?.ok).toBe(true)
    expect(index.def).toContain("(user_id)")
    expect(index.def).toContain("(notification_preferences ->> 'muted'::text) = 'true'::text")

    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off")
      return tx.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`
        EXPLAIN SELECT m.chat_group_id FROM chat_group_members m WHERE m.user_id = 'someone' AND m.status IN ('active', 'muted') AND ${mutedNowSql(new Date())}`)
    })
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("chat_group_members_muted_idx")
  })

  it("is built in a migration of its own that is one CONCURRENTLY statement", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("fs") as typeof import("fs")
    const sql = readFileSync("prisma/migrations/20261022140000_chat_group_members_muted_idx/migration.sql", "utf8")
    const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_group_members_muted_idx" ON "chat_group_members" \("user_id"\) WHERE \(notification_preferences->>'muted'\) = 'true'$/)
  })
})
