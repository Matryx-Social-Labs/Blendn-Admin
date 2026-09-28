import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { NextRequest } from "next/server"

import { GET as roomFeed } from "@/app/api/events/[id]/chat/messages/route"
import { PATCH as moderateMember } from "@/app/api/events/[id]/chat/members/[userId]/route"
import { getUsers } from "@/app/dashboard/users/actions"
import { attendeeRoster } from "@/lib/attendee-roster"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * SCRUM-383 (b): a host sees an attendee as a label and counts; an admin sees
 * the person.
 *
 * Real Postgres, because the leak was in what the query selected: the roster
 * put `user.name` on every check-in and looked up the rest by id, so a mocked
 * `db` returning only the fields a test thought of could never have shown it.
 * Every assertion about identity is made on the serialised output, the thing
 * that crosses to the browser, by searching it for the person's real name,
 * email and user id.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

async function makeOrg(label: string) {
  const org = await db.organisations.create({
    data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" },
  })
  orgs.push(org.id)
  return org.id
}

/** A past event of `orgId` with its one occurrence. */
async function pastEvent(orgId: string, creator: string, daysAgo: number) {
  const start = new Date(Date.now() - daysAgo * DAY)
  const event = await db.events.create({
    data: {
      slug: testId("labels"),
      title: `Labels ${daysAgo}d ago`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 2 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: creator,
      organizer_org_id: orgId,
    },
  })
  events.push(event.id)
  const occurrence = await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(start.toISOString().slice(0, 10)),
      start_time: start,
      end_time: event.end_time,
    },
  })
  return { id: event.id, occurrenceId: occurrence.id, start }
}

async function came(event: { id: string; occurrenceId: string; start: Date }, userId: string) {
  await db.event_check_ins.create({
    data: {
      event_id: event.id,
      occurrence_id: event.occurrenceId,
      user_id: userId,
      kind: "attendee",
      status: "checked_out",
      check_in_time: new Date(event.start.getTime() + HOUR),
    },
  })
}

async function rsvped(eventId: string, userId: string) {
  await db.event_rsvps.create({ data: { event_id: eventId, user_id: userId, status: "going" } })
}

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("an organiser sees labels and counts; an admin sees the person", () => {
  let hostA: string
  let colleagueA: string
  let hostB: string
  let admin: string
  let priya: string
  let rahul: string
  let priyaEmail: string
  let rahulEmail: string
  let firstA: Awaited<ReturnType<typeof pastEvent>>

  /** Everything that could name either attendee, as it would appear in JSON. */
  const identityOf = () => [priya, rahul, "Priya Realname", "Rahul Realname", priyaEmail, rahulEmail]

  beforeAll(async () => {
    hostA = await makeUser("hostA", "organizer")
    colleagueA = await makeUser("colleagueA", "organizer")
    hostB = await makeUser("hostB", "organizer")
    admin = await makeUser("admin", "app_admin")
    priya = await makeUser("priya")
    rahul = await makeUser("rahul")
    users.push(hostA, colleagueA, hostB, admin, priya, rahul)
    priyaEmail = `${priya}@itest.invalid`
    rahulEmail = `${rahul}@itest.invalid`
    await db.user.update({ where: { id: priya }, data: { name: "Priya Realname", image: "https://img.invalid/priya.jpg" } })
    await db.user.update({ where: { id: rahul }, data: { name: "Rahul Realname" } })
    await db.profiles.create({ data: { id: priya, name: "Priya Realname", phone: "+919800000001", onboarded: true } })

    const orgA = await makeOrg("a")
    const orgB = await makeOrg("b")
    await db.organisation_members.createMany({
      data: [
        { org_id: orgA, user_id: hostA, role: "owner" },
        { org_id: orgA, user_id: colleagueA, role: "staff" },
        { org_id: orgB, user_id: hostB, role: "owner" },
      ],
    })

    // Priya came to two of org A's events and one of org B's. Rahul RSVP'd to
    // one of org A's and never came -- the path that used to look his name up
    // separately.
    firstA = await pastEvent(orgA, hostA, 10)
    const secondA = await pastEvent(orgA, hostA, 3)
    const onlyB = await pastEvent(orgB, hostB, 5)
    await came(firstA, priya)
    await came(secondA, priya)
    await rsvped(secondA.id, priya)
    await rsvped(firstA.id, rahul)
    await came(onlyB, priya)
  })

  it("gives the organiser labels and counts, and nothing that names anybody", async () => {
    const roster = await attendeeRoster("organizer", hostA)

    expect(roster.rows).toHaveLength(2)
    for (const row of roster.rows) {
      expect(row.id).toMatch(/^attendee-[0-9a-f]{12}$/)
      expect(Object.keys(row).sort()).toEqual(["attended", "id", "lastAttendedAt", "noShows", "repeat", "rsvps"])
    }
    const [regular, noShow] = roster.rows
    expect(regular).toMatchObject({ attended: 2, rsvps: 1, noShows: 0, repeat: true })
    expect(noShow).toMatchObject({ attended: 0, rsvps: 1, noShows: 1, repeat: false, lastAttendedAt: null })
    expect(roster).toMatchObject({ uniqueAttendees: 1, repeatCount: 1 })

    const wire = JSON.stringify(roster)
    for (const secret of [...identityOf(), "img.invalid", "+919800000001"]) {
      expect(wire).not.toContain(secret)
    }
  })

  it("keeps one label per person across the organisation's events and its members", async () => {
    // Two check-ins at two events are one row: the label is what "came back"
    // is counted on, so it must not change between events.
    const mine = await attendeeRoster("organizer", hostA)
    const colleagues = await attendeeRoster("organizer", colleagueA)
    expect(colleagues.rows.map((r) => r.id)).toEqual(mine.rows.map((r) => r.id))
  })

  it("gives the same person a different label at another organisation", async () => {
    const atA = (await attendeeRoster("organizer", hostA)).rows.find((r) => r.attended === 2)!.id
    const atB = await attendeeRoster("organizer", hostB)
    expect(atB.rows).toHaveLength(1)
    expect(atB.rows[0]).toMatchObject({ attended: 1 })
    expect(atB.rows[0].id).not.toBe(atA)
  })

  it("still gives a platform admin the person, on the admin's own screen", async () => {
    // `/dashboard/attendees` sends an admin to `/dashboard/users`; that is the
    // full view the ruling keeps.
    as("app_admin", admin)
    const { users: found } = await getUsers(priyaEmail)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: priya, name: "Priya Realname", email: priyaEmail })
    expect(found[0].profile?.phone).toBe("+919800000001")
  })

  describe("the room", () => {
    let chatGroupId: string

    beforeAll(async () => {
      const group = await db.chat_groups.create({
        data: { event_id: firstA.id, name: testId("room") },
        select: { id: true },
      })
      chatGroupId = group.id
      await db.chat_group_members.create({
        data: { chat_group_id: chatGroupId, user_id: priya, anonymous_name: "Quiet Otter" },
      })
      await db.chat_messages.create({
        data: { chat_group_id: chatGroupId, user_id: priya, content: "the queue is long" },
      })
    })

    const feed = async () => {
      const res = await roomFeed(new Request(`http://localhost/api/events/${firstA.id}/chat/messages`), {
        params: Promise.resolve({ id: firstA.id }),
      })
      expect(res.status).toBe(200)
      return (await res.json()) as {
        messages: { user: { id: string; anonymousName: string | null; name?: string; email?: string } }[]
      }
    }

    it("shows the organiser the room's pseudonym, and moderation still works by the member's id", async () => {
      as("organizer", hostA)
      const body = await feed()
      const [message] = body.messages
      expect(message.user.anonymousName).toBe("Quiet Otter")
      expect(message.user).not.toHaveProperty("name")
      expect(message.user).not.toHaveProperty("email")
      const wire = JSON.stringify(body)
      for (const secret of ["Priya Realname", priyaEmail, "img.invalid"]) expect(wire).not.toContain(secret)

      const res = await moderateMember(
        new NextRequest(`http://localhost/api/events/${firstA.id}/chat/members/${message.user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ action: "mute" }),
        }),
        { params: Promise.resolve({ id: firstA.id, userId: message.user.id }) }
      )
      expect(res.status).toBe(200)
      const member = await db.chat_group_members.findUniqueOrThrow({
        where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: priya } },
        select: { status: true, muted_by: true },
      })
      expect(member).toEqual({ status: "muted", muted_by: hostA })
    })

    it("shows a platform admin who wrote it", async () => {
      as("app_admin", admin)
      const [message] = (await feed()).messages
      expect(message.user).toMatchObject({ anonymousName: "Quiet Otter", name: "Priya Realname", email: priyaEmail })
    })
  })
})
