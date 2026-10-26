jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { conversationPair } from "@/lib/conversations"
import { performCheckout, performCheckouts } from "@/lib/checkout"

import { sqlCounter } from "./sql-count"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * The sweepers close people in batches (`performCheckouts`); this holds the
 * batch to what `performCheckout` does one person at a time. The same world is
 * emptied twice -- one by one, then in one batch, after being put back -- and
 * must end in the same rows and tell every viewer the same thing, in far fewer
 * statements. Two events, so a batch spans rooms.
 */

const PER_ROOM = 6
const users: string[] = []
const events: string[] = []

interface Heard {
  to: string
  event: string
  payload: Record<string, unknown>
}
let heard: Heard[] = []

/** A fake `io` with one socket per user in `event:{id}`, recording what each hears. */
function installIo(viewersByEvent: Map<string, string[]>) {
  const socketsOf = (room: string) => {
    const eventId = room.replace(/^event:/, "")
    return (viewersByEvent.get(eventId) ?? []).map((userId) => ({
      id: `sock-${userId}`,
      data: { userId },
      emit: (event: string, payload: Record<string, unknown>) => void heard.push({ to: userId, event, payload }),
      leave: () => undefined,
    }))
  }
  const target = (room: string) => ({
    fetchSockets: async () => (room.startsWith("event:room:") ? [] : socketsOf(room)),
    except: () => target(room),
    socketsLeave: () => undefined,
  })
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = { in: target, to: (rooms: string[]) => ({ emit: (event: string, payload: Record<string, unknown>) => void heard.push({ to: [rooms].flat().sort().join(), event, payload }) }) }
}

/** The emitters and the friends-here signals are fire-and-forget: wait until nothing more is heard or asked. */
let counted: { statements: string[] } | null = null
const settle = async () => {
  let seen = -1
  while (seen !== heard.length + (counted?.statements.length ?? 0)) {
    seen = heard.length + (counted?.statements.length ?? 0)
    await new Promise((r) => setTimeout(r, 200))
  }
}

afterAll(async () => {
  delete (globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

async function world() {
  const host = await makeUser(testId("bc-host"), "organizer")
  users.push(host)
  const rooms = []
  for (const label of ["a", "b"]) {
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)
    const stays = await makeUser(testId(`bc-stays-${label}`))
    users.push(stays)
    await onboard(stays)
    await putInRoom({ eventId, occurrenceId, userId: stays })
    const leavers: string[] = []
    for (let i = 0; i < PER_ROOM; i++) {
      const id = await makeUser(testId(`bc-${label}${i}`))
      users.push(id)
      await onboard(id)
      await putInRoom({ eventId, occurrenceId, userId: id, kind: i === 0 ? "staff" : "attendee", at: new Date(Date.now() - 3_600_000) })
      leavers.push(id)
    }
    rooms.push({ eventId, occurrenceId, stays, leavers })
  }
  // Seen differently by the viewer who stays: a friend, a show-online-off leaver, a block.
  const [a, b] = rooms
  const [f1, f2] = conversationPair(a.stays, a.leavers[1])
  await db.friendships.create({ data: { user1_id: f1, user2_id: f2 } })
  await db.profiles.update({ where: { id: a.leavers[2] }, data: { show_online: false } })
  // The friend who stays is told their Friends here moved when the opted-in friend leaves.
  await db.profiles.update({ where: { id: a.leavers[1] }, data: { friends_see_me_in_rooms: true } })
  await db.blocked_users.create({ data: { blocker_id: b.stays, blocked_id: b.leavers[1] } })
  return rooms
}

/** Put every leaver back inside, as the world began. */
async function reset(rooms: Awaited<ReturnType<typeof world>>) {
  const ids = rooms.flatMap((r) => r.leavers)
  await db.event_check_ins.updateMany({ where: { user_id: { in: ids } }, data: { status: "checked_in", check_out_time: null } })
  await db.presence_sessions.updateMany({ where: { user_id: { in: ids } }, data: { departed_at: null, departed_source: null } })
}

async function snapshot(rooms: Awaited<ReturnType<typeof world>>) {
  const ids = rooms.flatMap((r) => r.leavers.concat(r.stays))
  const checkIns = await db.event_check_ins.findMany({
    where: { user_id: { in: ids } },
    select: { user_id: true, status: true, check_out_time: true, updated_at: true },
    orderBy: { user_id: "asc" },
  })
  const sessions = await db.presence_sessions.findMany({
    where: { user_id: { in: ids } },
    select: { user_id: true, departed_at: true, departed_source: true },
    orderBy: { user_id: "asc" },
  })
  return { checkIns, sessions }
}

const bare = (list: Heard[]) =>
  list
    .filter((h) => h.event === "event:checkout")
    .map(({ to, payload }) => ({ to, userId: payload.userId ?? null }))
    .sort((a, b) => `${a.to}${a.userId}`.localeCompare(`${b.to}${b.userId}`))

it("empties two rooms in a batch to the same rows and the same telling as one at a time, in far fewer statements", async () => {
  const rooms = await world()
  installIo(new Map(rooms.map((r) => [r.eventId, [r.stays, ...r.leavers]])))
  const rowsOf = async () =>
    (await db.event_check_ins.findMany({ where: { user_id: { in: rooms.flatMap((r) => r.leavers) }, status: "checked_in" }, select: { id: true } })).map((r) => r.id)
  const at = new Date(Date.now() - 1_000)
  const counter = sqlCounter()
  counted = counter
  try {
    // One at a time: the path the sweepers used.
    let ids = await rowsOf()
    const one = await counter.during(async () => {
      for (const id of ids) await performCheckout(id, "occurrence_ended", at)
      await settle()
    })
    const oneHeard = [...heard]
    const oneRows = await snapshot(rooms)
    const afterOne = rooms.map((r) => ({ event: r.eventId, here: 0 }))
    expect(afterOne).toHaveLength(2)

    await reset(rooms)
    heard = []
    ids = await rowsOf()
    const batch = await counter.during(async () => {
      const done = await performCheckouts(ids.map((id) => ({ id, at })), "occurrence_ended")
      await settle()
      return done
    })
    const batchRows = await snapshot(rooms)

    expect(ids).toHaveLength(2 * PER_ROOM)
    expect(batch.result.map((r) => r.userId).sort()).toEqual(rooms.flatMap((r) => r.leavers).sort())
    // The rows: status, time, sessions closed with the same source, the same instant.
    expect(batchRows).toEqual(oneRows)
    expect(batchRows.sessions.filter((s) => s.departed_source === "sweeper")).toHaveLength(2 * PER_ROOM)
    // The telling: every viewer got the same copy for every leaver (friend, hidden and blocked included).
    expect(bare(heard)).toEqual(bare(oneHeard))
    // Friends here: the same people are told to refetch (one signal per event instead of one per leaver).
    const friendSignals = (list: Heard[]) => [...new Set(list.filter((h) => h.event === "room:friends").map((h) => `${h.to}:${h.payload.eventId}`))].sort()
    expect(friendSignals(heard)).toEqual(friendSignals(oneHeard))
    expect(friendSignals(heard)).toHaveLength(1)
    // The world is not trivial: a copy without a handle (a friend's, a hidden leaver's, a blocked pair's) and one with.
    expect(bare(heard).some((h) => h.userId === null)).toBe(true)
    expect(bare(heard).some((h) => h.userId !== null)).toBe(true)
    // One headcount per room, and it is the room once all are out.
    for (const h of heard.filter((x) => x.event === "event:checkout")) expect(h.payload.hereCount).toBe(1)
    // And the cost.
    console.info(`checkout of ${ids.length} in 2 rooms: one at a time ${one.sql.length} statements, batched ${batch.sql.length}`)
    expect(batch.sql.length).toBeLessThanOrEqual(30)
    expect(batch.sql.length).toBeLessThan(one.sql.length / 5)

    // Idempotent: a second pass finds them all out and changes nothing.
    expect(await performCheckouts(ids.map((id) => ({ id, at })), "occurrence_ended")).toEqual([])
  } finally {
    counted = null
    await counter.stop()
  }
})

it("an expiry acts only on the window it read", async () => {
  const [room] = await world()
  const id = room.leavers[3]
  const row = await db.event_check_ins.findFirstOrThrow({ where: { user_id: id }, select: { id: true } })
  const ends = new Date(Date.now() - 60_000)
  await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: new Date(ends.getTime() + 600_000) } })
  // Going live again moved the window past the one the sweep read.
  expect(await performCheckouts([{ id: row.id, at: ends }], "expired")).toEqual([])
  await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: ends } })
  expect(await performCheckouts([{ id: row.id, at: ends }], "expired")).toHaveLength(1)
  const session = await db.presence_sessions.findFirstOrThrow({ where: { user_id: id }, select: { departed_at: true, departed_source: true } })
  expect(session.departed_source).toBe("expired")
  expect(session.departed_at).toEqual(ends)
})
