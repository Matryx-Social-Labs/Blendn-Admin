// Relative imports throughout — see lib/conversations.ts.
import { db } from "../db"
import { strangersApartBetween } from "../room-people"
import { blocksExclude } from "./blocks"
import { hiddenOf } from "./hides"
import { membersOf } from "./presence"

/**
 * The crews that waved at one person in one room (crews 5-A, S5 b2): what the
 * person is shown of a crew → person wave (`likePersonAsCrew` with a wave).
 * Apart from the person waves (`receivedWaves`), so an installed build's
 * `total` still matches its `waves` (decided per advisor, 2026-11-21).
 *
 * Read with the like's own rules, asked again now: a crew that ended or a
 * moderator hid, one the person hid, and one with anybody kept apart from them
 * (a block, a closed conversation, a friend) is not listed — a block landing
 * after the wave takes it away.
 */

/**
 * ponytail: one wave per crew per person per occurrence, and only crews of
 * `CREW.MAX_SOLO_MATCH` or fewer with "Room for one more" may send one, so a
 * person gets a handful; the newest this many are read, unpaged. Keyset paging
 * like `receivedWaves` if a room ever fills it.
 */
export const CREW_WAVES_MAX = 50

export interface CrewWave {
  crewId: string
  name: string
  emblemSeed: string
  wavedAt: string
  /** Whether you answered it: your wave or like at that crew, that night. */
  wavedBack: boolean
}

export async function crewWavesAt(viewerId: string, eventId: string): Promise<CrewWave[]> {
  const rows = await db.crew_likes.findMany({
    where: { to_user_id: viewerId, is_wave: true, occurrence: { event_id: eventId }, from_crew: { dissolved_at: null, hidden_at: null } },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: CREW_WAVES_MAX,
    select: { occurrence_id: true, from_crew_id: true, created_at: true, from_crew: { select: { name: true, emblem_seed: true } } },
  })
  if (rows.length === 0) return []
  const crewIds = [...new Set(rows.map((r) => r.from_crew_id as string))]
  const [hidden, members, back] = await Promise.all([
    hiddenOf(viewerId, crewIds),
    membersOf(crewIds),
    db.crew_likes.findMany({
      where: { from_user_id: viewerId, to_crew_id: { in: crewIds }, occurrence: { event_id: eventId } },
      select: { to_crew_id: true, occurrence_id: true },
    }),
  ])
  const apart = await strangersApartBetween([viewerId], [...new Set([...members.values()].flat())])
  const answered = new Set(back.map((b) => `${b.to_crew_id}|${b.occurrence_id}`))
  const seen = new Set<string>()
  const out: CrewWave[] = []
  // Newest first, so a crew that waved on two nights of a run is listed once, by its latest.
  for (const r of rows) {
    const crewId = r.from_crew_id as string
    if (seen.has(crewId)) continue
    seen.add(crewId)
    if (hidden.has(crewId) || blocksExclude([viewerId], members.get(crewId) ?? [], apart)) continue
    out.push({
      crewId,
      name: r.from_crew!.name,
      emblemSeed: r.from_crew!.emblem_seed,
      wavedAt: r.created_at.toISOString(),
      wavedBack: answered.has(`${crewId}|${r.occurrence_id}`),
    })
  }
  return out
}

export interface CrewWaitingRoom {
  eventId: string
  /** Crews here whose wave you have not answered. */
  waiting: number
  latest: CrewWave
}

/** At most this many rooms read for Banter, as `wavesWaiting`. */
const SUMMARY_ROOMS = 20

/**
 * Banter's `crewRooms`: every room where a crew's wave is waiting for you,
 * newest first. A room `shut` to you or no longer open is left out; `open` is
 * `roomIsOpen` (lib/waves.ts), passed in so this module stays below it.
 */
export async function crewWavesWaiting(
  viewerId: string,
  isOpen: (eventId: string) => Promise<boolean>,
  shut: (eventId: string) => Promise<boolean>
): Promise<CrewWaitingRoom[]> {
  const nights = await db.crew_likes.groupBy({
    by: ["occurrence_id"],
    where: { to_user_id: viewerId, is_wave: true },
    _max: { created_at: true },
    orderBy: { _max: { created_at: "desc" } },
    take: SUMMARY_ROOMS,
  })
  if (nights.length === 0) return []
  const occurrences = await db.event_occurrences.findMany({
    where: { id: { in: nights.map((n) => n.occurrence_id) } },
    select: { id: true, event_id: true },
  })
  const eventOf = new Map(occurrences.map((o) => [o.id, o.event_id]))
  const eventIds = [...new Set(nights.map((n) => eventOf.get(n.occurrence_id)).filter((id): id is string => !!id))]
  const out: CrewWaitingRoom[] = []
  for (const eventId of eventIds) {
    if (!(await isOpen(eventId)) || (await shut(eventId))) continue
    const waiting = (await crewWavesAt(viewerId, eventId)).filter((w) => !w.wavedBack)
    if (waiting.length > 0) out.push({ eventId, waiting: waiting.length, latest: waiting[0] })
  }
  return out
}
