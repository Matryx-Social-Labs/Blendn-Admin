import { getTrustSignal, MIN_RATINGS, ratablePeers } from "@/lib/trust"

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

async function connect(eventId: string, a: string, b: string) {
  await like(eventId, a, b)
  await like(eventId, b, a)
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("who you may rate", () => {
  it("only someone you connected with", async () => {
    // A mutual like means both people opted in. Anyone else merely shared a room.
    const eventId = await pastEvent()
    const [me, matched, stranger] = await Promise.all([
      guest("tr-a"), guest("tr-b"), guest("tr-c"),
    ])
    await connect(eventId, me, matched)

    expect(await ratablePeers(eventId, me)).toEqual([matched])
    expect(await ratablePeers(eventId, me)).not.toContain(stranger)
  })

  it("not someone who never liked you back", async () => {
    // Otherwise a rating becomes the consolation prize for being declined.
    const eventId = await pastEvent()
    const [me, them] = await Promise.all([guest("tr-d"), guest("tr-e")])
    await like(eventId, me, them)

    expect(await ratablePeers(eventId, me)).toEqual([])
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

    expect(await ratablePeers(eventId, me)).toEqual([])
  })

  it("drops off the list once rated", async () => {
    const eventId = await pastEvent()
    const [me, them] = await Promise.all([guest("tr-h"), guest("tr-i")])
    await connect(eventId, me, them)

    await db.peer_ratings.create({
      data: { event_id: eventId, rater_id: me, rated_id: them, rating: 5 },
    })
    expect(await ratablePeers(eventId, me)).toEqual([])
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
    const t = await getTrustSignal(who)
    expect(t.ratings).toBe(2)
    expect(t.average).toBeNull()
    expect(t.band).toBe("unrated")
  })

  it("bands once there is enough", async () => {
    const who = await guest("tr-k")
    await rate(who, Array(MIN_RATINGS).fill(5))
    const t = await getTrustSignal(who)
    expect(t.average).toBe(5)
    expect(t.band).toBe("good")
  })

  it("never averages a harassment report away", async () => {
    // Four glowing ratings and one harassment report is not a 4.2. Any design
    // where volume dilutes it is wrong.
    const who = await guest("tr-l")
    await rate(who, [5, 5, 5, 5, 5], "harassment")

    const t = await getTrustSignal(who)
    expect(t.band).toBe("good")
    expect(t.hasHarassmentReport).toBe(true)
    expect(t.issues.harassment).toBe(1)
  })

  it("reports issues even for someone with too few ratings to band", async () => {
    // A single report is worth surfacing on its own; the volume floor guards
    // the average, not the reports.
    const who = await guest("tr-m")
    await rate(who, [2], "uncomfortable")

    const t = await getTrustSignal(who)
    expect(t.band).toBe("unrated")
    expect(t.issues.uncomfortable).toBe(1)
  })

  it("is empty for someone nobody has rated", async () => {
    const t = await getTrustSignal(await guest("tr-n"))
    expect(t).toMatchObject({ ratings: 0, average: null, band: "unrated", hasHarassmentReport: false })
  })
})
