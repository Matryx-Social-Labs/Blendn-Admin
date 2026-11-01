import { conversationPair } from "@/lib/conversations"
import { MIN_RATINGS, ratablePeers, trustSignalsFor } from "@/lib/trust"

import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

/**
 * Who may rate whom, and what the signal says.
 *
 * The gate is the whole integrity of the table. If anyone who shared a room can
 * rate anyone else, this becomes a review-bombing surface and a way to punish
 * someone for declining — which is the opposite of a safety mechanism.
 */

const users: string[] = []
const events: string[] = []

async function pastEvent() {
  const host = await makeUser("tr-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const now = Date.now()
  await db.events.update({
    where: { id: eventId },
    data: { start_time: new Date(now - 4 * 3600_000), end_time: new Date(now - 3600_000) },
  })
  return eventId
}

async function guest(label: string) {
  const id = await makeUser(label)
  users.push(id)
  return id
}

const like = (eventId: string, a: string, b: string) =>
  db.event_likes.create({ data: { event_id: eventId, liker_id: a, liked_id: b } })

/**
 * A match made at this event: the mutual like and the conversation it opened,
 * revealed on both sides so the ref a rating names is the plain id (an
 * unrevealed match is a handle: dm-handle / friend-held itests).
 */
async function connect(eventId: string, a: string, b: string) {
  await like(eventId, a, b)
  await like(eventId, b, a)
  const [user1_id, user2_id] = conversationPair(a, b)
  await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      origin_event_id: eventId,
      user1_pseudonym: "Otter",
      user2_pseudonym: "Heron",
      user1_revealed: true,
      user2_revealed: true,
    },
  })
}

/** Who a person may rate, as the ids the list names. */
const peers = async (eventId: string, raterId: string) => (await ratablePeers(eventId, raterId)).map((p) => p.ref)

afterAll(async () => {
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { blocker_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

/**
 * `trustSignalsFor` is plural — the only production reader is the moderation
 * queue, which shows up to a hundred flagged messages at a time, and a singular
 * lookup there is a hundred round trips. These cases are about one person, so
 * they ask for one and unwrap it.
 */
async function signalFor(userId: string) {
  const signal = (await trustSignalsFor([userId])).get(userId)
  if (!signal) throw new Error("every id asked about must get an answer")
  return signal
}

describe("who you may rate", () => {
  it("only someone you connected with", async () => {
    // A mutual like means both people opted in. Anyone else merely shared a room.
    const eventId = await pastEvent()
    const [me, matched, stranger] = await Promise.all([
      guest("tr-a"), guest("tr-b"), guest("tr-c"),
    ])
    await connect(eventId, me, matched)

    expect(await peers(eventId, me)).toEqual([matched])
    expect(await peers(eventId, me)).not.toContain(stranger)
  })

  it("not someone who never liked you back", async () => {
    // Otherwise a rating becomes the consolation prize for being declined.
    const eventId = await pastEvent()
    const [me, them] = await Promise.all([guest("tr-d"), guest("tr-e")])
    await like(eventId, me, them)

    expect(await peers(eventId, me)).toEqual([])
  })

  it("nobody until the event has ended", async () => {
    // Asked during the night a rating is leverage; asked afterwards it is
    // reflection.
    const host = await makeUser("tr-host2", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)   // fixture is live right now
    events.push(eventId)
    const [me, them] = await Promise.all([guest("tr-f"), guest("tr-g")])
    await connect(eventId, me, them)

    expect(await peers(eventId, me)).toEqual([])
  })

  it("drops off the list once rated", async () => {
    const eventId = await pastEvent()
    const [me, them] = await Promise.all([guest("tr-h"), guest("tr-i")])
    await connect(eventId, me, them)

    await db.peer_ratings.create({
      data: { event_id: eventId, rater_id: me, rated_id: them, rating: 5 },
    })
    expect(await peers(eventId, me)).toEqual([])
  })

  it("not someone you blocked, nor someone who blocked you (SCRUM-304)", async () => {
    // A block hides each from the other on the profile, in matches and in the
    // room roster. A ratable list is one more place to see someone, and a
    // rating from the blocked person is retaliation into the other's trust
    // signal. The one who blocked still has the report route.
    const eventId = await pastEvent()
    const [blocker, blocked, friend] = await Promise.all([guest("tr-j"), guest("tr-k"), guest("tr-l")])
    await connect(eventId, blocker, blocked)
    await connect(eventId, blocker, friend)
    expect(await peers(eventId, blocked)).toEqual([blocker]) // connected, so ratable — until:

    await db.blocked_users.create({ data: { blocker_id: blocker, blocked_id: blocked } })
    expect(await peers(eventId, blocked)).toEqual([])
    expect(await peers(eventId, blocker)).toEqual([friend])
  })

  it("not someone who has deleted their account (SCRUM-989)", async () => {
    // The rate-the-night screen offered a deleted account: nobody is there to rate, and a rating would land on an
    // anonymised row.
    const eventId = await pastEvent()
    const [me, gone, stays] = await Promise.all([guest("tr-m"), guest("tr-n"), guest("tr-o")])
    await connect(eventId, me, gone)
    await connect(eventId, me, stays)
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    expect(await peers(eventId, me)).toEqual([stays])
  })
})

describe("the signal", () => {
  async function rate(ratedId: string, values: number[], issue?: string) {
    for (const [i, rating] of values.entries()) {
      const eventId = await pastEvent()
      const rater = await guest(`tr-r${i}-${Math.random().toString(36).slice(2, 6)}`)
      await db.peer_ratings.create({
        data: {
          event_id: eventId,
          rater_id: rater,
          rated_id: ratedId,
          rating,
          ...(issue && i === 0 ? { issue: issue as never } : {}),
        },
      })
    }
  }

  it("withholds an average below the floor", async () => {
    const who = await guest("tr-j")
    await rate(who, [5, 5])
    const t = await signalFor(who)
    expect(t.ratings).toBe(2)
    expect(t.average).toBeNull()
    expect(t.band).toBe("unrated")
  })

  it("bands once there is enough", async () => {
    const who = await guest("tr-k")
    await rate(who, Array(MIN_RATINGS).fill(5))
    const t = await signalFor(who)
    expect(t.average).toBe(5)
    expect(t.band).toBe("good")
  })

  it("never averages a harassment report away", async () => {
    // Four glowing ratings and one harassment report is not a 4.2. Any design
    // where volume dilutes it is wrong.
    const who = await guest("tr-l")
    await rate(who, [5, 5, 5, 5, 5], "harassment")

    const t = await signalFor(who)
    expect(t.band).toBe("good")
    expect(t.hasHarassmentReport).toBe(true)
    expect(t.issues.harassment).toBe(1)
  })

  it("reports issues even for someone with too few ratings to band", async () => {
    // A single report is worth surfacing on its own; the volume floor guards
    // the average, not the reports.
    const who = await guest("tr-m")
    await rate(who, [2], "uncomfortable")

    const t = await signalFor(who)
    expect(t.band).toBe("unrated")
    expect(t.issues.uncomfortable).toBe(1)
  })

  it("is empty for someone nobody has rated", async () => {
    const t = await signalFor(await guest("tr-n"))
    expect(t).toMatchObject({ ratings: 0, average: null, band: "unrated", hasHarassmentReport: false })
  })
})
