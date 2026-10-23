import { execFileSync } from "child_process"
import { join } from "path"

import {
  BOARD_POSTS,
  CHECK_IN_TAG,
  ID_PREFIX,
  PER_TARGET,
  ROOM_STRANGERS,
  TARGET_EMAILS,
  canonicalPair,
  crowdEmail,
  crowdId,
  friendSlices,
  layoutFor,
  listableFriends,
  personFor,
  plannedCounts,
  plusCompRefusal,
  uuidFor,
} from "../scripts/seed-qa-scale-plan"
import {
  QA_VENUE_ID,
  banterRows,
  boardRows,
  crowdRows,
  eventRows,
  historyRows,
  roomRows,
  socialRows,
} from "../scripts/seed-qa-scale-rows"

/**
 * The scale seed's rows, checked before any database sees them: every
 * rule the migrations hold as a CHECK or a unique index, and every page
 * threshold the large-data drive needs the data to be past.
 */

const NOW = new Date("2026-10-23T12:00:00.000Z")
const targets = TARGET_EMAILS.map((email, i) => ({ id: `target${i}`, email }))
const layout = layoutFor(targets.length)
const big = { eventId: uuidFor("big-event"), occurrenceId: uuidFor("big-occ") }
const second = { eventId: uuidFor("second-event"), occurrenceId: uuidFor("second-occ") }
const portraits = { woman: ["w1", "w2", "w3"], man: ["m1", "m2", "m3"] }

const duplicates = <T>(values: T[]) => values.filter((v, i) => values.indexOf(v) !== i)

describe("the layout: one person, one role", () => {
  const roles = [
    layout.host,
    ...layout.strangers,
    ...layout.targets.flatMap((t) => [...t.friends, ...t.messageRequesters, ...t.friendRequesters, ...t.matchPeers.flat()]),
  ]

  it("gives nobody two roles, and leaves no gap in the crowd", () => {
    expect(duplicates(roles)).toEqual([])
    expect(roles.length).toBe(layout.size)
    expect(Math.max(...roles)).toBe(layout.size - 1)
  })

  it("counts what the plan says", () => {
    const c = plannedCounts(3)
    expect(c.crowdUsers).toBe(1 + 3 * (1000 + 60 + 60 + 18) + ROOM_STRANGERS)
    expect(layout.size).toBe(c.crowdUsers)
  })

  it("ids and addresses are the QA tag, four digits", () => {
    expect(crowdId(7)).toBe(`${ID_PREFIX}0007`)
    expect(crowdEmail(7)).toBe("qa.scale.0007@blendn.app")
    expect(personFor(7).email).toBe(crowdEmail(7))
  })

  it("is the same on every run", () => {
    expect(uuidFor("x")).toBe(uuidFor("x"))
    expect(uuidFor("x")).not.toBe(uuidFor("y"))
    expect(uuidFor("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe("who may be comped Blendn+", () => {
  it.each(["qa.rc.a@blendn.app", "qa.rc.c@blendn.app", "qa.scale.0001@blendn.app"])("allows the throwaway %s", (email) => {
    expect(plusCompRefusal(email)).toBeNull()
  })

  it.each(["admin@blendn.app", "sagar.kishore@blendn.app", "qa.someone@gmail.com", "x.qa.rc.a@blendn.app", ""])("refuses %s", (email) => {
    expect(plusCompRefusal(email)).toMatch(/only throwaway qa\.\*@blendn\.app/)
  })
})

describe("the crowd", () => {
  const { users, profiles, interests } = crowdRows(layout, portraits, NOW, Array.from({ length: 16 }, (_, i) => uuidFor(`leaf${i}`)))

  it("is a user, a profile and three interests each, all of age and onboarded", () => {
    expect(users).toHaveLength(layout.size)
    expect(profiles).toHaveLength(layout.size)
    expect(interests).toHaveLength(layout.size * 3)
    expect(profiles.every((p) => p.onboarded === true && (p.age as number) >= 21)).toBe(true)
    expect(users.every((u) => u.email.endsWith("@blendn.app") && u.email.startsWith("qa.scale.") && !("password" in u))).toBe(true)
  })

  it("turns Friends here on for exactly the room friends, and show-online on for them", () => {
    const listable = listableFriends(layout)
    expect(listable.size).toBe(3 * (PER_TARGET.bigRoomFriends + PER_TARGET.secondRoomFriends))
    for (const p of profiles) {
      const index = Number((p.id as string).slice(ID_PREFIX.length))
      expect(p.friends_see_me_in_rooms).toBe(listable.has(index))
    }
    expect(profiles.every((p) => p.show_online === true)).toBe(true)
  })

  it("has photos, from the ones already in the seed", () => {
    expect(users.every((u) => /^https:\/\/images\.unsplash\.com\/(w|m)\d\?/.test(u.image as string))).toBe(true)
    expect(profiles.every((p) => (p.photos as string[]).length === 1 && typeof p.blur_photo === "string")).toBe(true)
  })

  it("makes no interest rows with fewer than three leaf categories to pick from", () => {
    expect(crowdRows(layout, portraits, NOW, ["a", "b"]).interests).toEqual([])
  })
})

describe("the social graph", () => {
  const { friendships, friendRequests, messageRequests } = socialRows(layout, targets, NOW)

  it("is 1,000 friendships a target, in the canonical order the CHECK holds, none with oneself", () => {
    expect(friendships).toHaveLength(3000)
    for (const f of friendships) {
      expect((f.user1_id as string) < (f.user2_id as string)).toBe(true)
    }
    expect(duplicates(friendships.map((f) => `${f.user1_id}|${f.user2_id}`))).toEqual([])
    expect(canonicalPair("b", "a")).toEqual(["a", "b"])
  })

  it("keeps requesters out of the friend list, so a request is never from a friend", () => {
    targets.forEach((t, i) => {
      const friends = new Set(layout.targets[i].friends.map(crowdId))
      expect(friendRequests.filter((r) => r.recipient_id === t.id).every((r) => !friends.has(r.sender_id as string))).toBe(true)
      expect(messageRequests.filter((r) => r.recipient_id === t.id).every((r) => !friends.has(r.sender_id as string))).toBe(true)
    })
  })

  it("is past a page for each list the drive pages", () => {
    const per = (rows: { recipient_id?: unknown }[], id: string) => rows.filter((r) => r.recipient_id === id).length
    expect(per(friendRequests, "target0")).toBeGreaterThan(50)
    expect(per(messageRequests, "target0")).toBeGreaterThan(50)
    expect(messageRequests.every((r) => r.status === "pending" && typeof r.message === "string")).toBe(true)
  })
})

describe("banter", () => {
  const { conversations, messages } = banterRows(layout, targets, NOW)
  const ids = new Set(conversations.map((c) => c.id))

  it("is past the inbox's 50-row page for each target", () => {
    for (const t of targets) {
      expect(conversations.filter((c) => c.user1_id === t.id || c.user2_id === t.id).length).toBe(78)
    }
  })

  it("holds one conversation per pair, in canonical order", () => {
    expect(duplicates(conversations.map((c) => `${c.user1_id}|${c.user2_id}`))).toEqual([])
    expect(conversations.every((c) => (c.user1_id as string) < (c.user2_id as string))).toBe(true)
  })

  it("has friend DMs named (revealed, no pseudonym) and matches pseudonymous, from a past night", () => {
    const friendDms = conversations.filter((c) => c.origin_friendship)
    const matches = conversations.filter((c) => c.origin_event_id)
    expect(friendDms).toHaveLength(180)
    expect(matches).toHaveLength(54)
    expect(friendDms.every((c) => !c.user1_pseudonym && !c.user2_pseudonym && c.user1_revealed && c.user2_revealed)).toBe(true)
    expect(matches.every((c) => !!c.user1_pseudonym && !!c.user2_pseudonym && !c.origin_friendship)).toBe(true)
  })

  it("lets the target rate six matches at each of three nights, none of them a friend", () => {
    const friends = new Set(layout.targets[0].friends.map(crowdId))
    const mine = conversations.filter((c) => c.origin_event_id && (c.user1_id === "target0" || c.user2_id === "target0"))
    const byNight = new Map<string, number>()
    for (const c of mine) byNight.set(c.origin_event_id as string, (byNight.get(c.origin_event_id as string) ?? 0) + 1)
    expect([...byNight.values()]).toEqual([6, 6, 6])
    for (const c of mine) expect(friends.has((c.user1_id === "target0" ? c.user2_id : c.user1_id) as string)).toBe(false)
  })

  it("has messages that belong to a conversation, a sender who is in it, and no client_id clash", () => {
    const members = new Map(conversations.map((c) => [c.id, [c.user1_id, c.user2_id]]))
    for (const m of messages) {
      expect(ids.has(m.conversation_id)).toBe(true)
      expect(members.get(m.conversation_id)).toContain(m.sender_id)
    }
    expect(messages.some((m) => m.is_read === false)).toBe(true)
  })
})

describe("events", () => {
  const { specs, events, occurrences } = eventRows(NOW, crowdId(0), "blendn-system")

  it("has 35 coming up at one venue (past the Coming up cap of 5), 36 past nights and 8 visits", () => {
    expect(events.filter((e) => e.status === "published" && e.kind === "event" && new Date(e.end_time as Date) >= NOW)).toHaveLength(35)
    expect(events.filter((e) => e.status === "completed")).toHaveLength(36)
    expect(events.filter((e) => e.kind === "venue_day")).toHaveLength(8)
    expect(events.every((e) => e.venue_id === QA_VENUE_ID)).toBe(true)
  })

  it("makes every venue day the shape the CHECK holds: unlisted, the system user's, no organisation, one per start", () => {
    const days = events.filter((e) => e.kind === "venue_day")
    expect(days.every((e) => e.visibility === "unlisted" && e.organizer_id === "blendn-system" && e.organizer_org_id == null)).toBe(true)
    expect(duplicates(days.map((e) => (e.start_time as Date).toISOString()))).toEqual([])
  })

  it("gives every event one occurrence, on the date it starts, and a unique slug and id", () => {
    expect(occurrences).toHaveLength(events.length)
    expect(duplicates(events.map((e) => e.slug))).toEqual([])
    expect(duplicates(events.map((e) => e.id))).toEqual([])
    specs.forEach((s, i) => {
      expect((occurrences[i].occurs_on as Date).toISOString().slice(0, 10)).toBe(s.start.toISOString().slice(0, 10))
      expect(s.end > s.start).toBe(true)
    })
  })

  it("keeps every past night over, and every coming one ahead", () => {
    for (const s of specs.filter((x) => x.status === "completed")) expect(s.end < NOW).toBe(true)
    for (const s of specs.filter((x) => x.kind === "event" && x.status === "published")) expect(s.start > NOW).toBe(true)
  })
})

describe("going history", () => {
  const { rsvps, checkIns, sessions } = historyRows(layout, targets, NOW)

  it("is 35 coming-up RSVPs past a page and 36 past, per target", () => {
    expect(rsvps.filter((r) => r.user_id === "target0")).toHaveLength(35 + 36)
  })

  it("is 36 nights and 8 visits attended, plus the matches' own nights", () => {
    expect(checkIns.filter((c) => c.user_id === "target0")).toHaveLength(44)
    expect(checkIns.length).toBe(3 * 44 + 54)
    expect(sessions).toHaveLength(checkIns.length)
  })

  it("has one check-in per person per occurrence, none open, all tagged, a visit ending with its window", () => {
    expect(duplicates(checkIns.map((c) => `${c.occurrence_id}|${c.user_id}`))).toEqual([])
    expect(checkIns.every((c) => c.status === "checked_out" && c.device_info === CHECK_IN_TAG)).toBe(true)
    expect(sessions.every((s) => (s.departed_at as Date) >= (s.arrived_at as Date))).toBe(true)
    expect(checkIns.filter((c) => c.expires_at).length).toBe(3 * 8)
  })
})

describe("the rooms", () => {
  const { checkIns, sessions } = roomRows(layout, targets, NOW, big, second)

  it("puts each target, their 60 friends and 300 strangers in the big room; 4 friends each in the second", () => {
    const inBig = checkIns.filter((c) => c.occurrence_id === big.occurrenceId)
    expect(inBig).toHaveLength(3 + 3 * 60 + 300)
    expect(checkIns.filter((c) => c.occurrence_id === second.occurrenceId)).toHaveLength(12)
    targets.forEach((t) => expect(inBig.some((c) => c.user_id === t.id)).toBe(true))
  })

  it("gives nobody two open check-ins (the partial unique index), or two rows in one occurrence", () => {
    expect(duplicates(checkIns.map((c) => c.user_id))).toEqual([])
    expect(duplicates(checkIns.map((c) => `${c.occurrence_id}|${c.user_id}`))).toEqual([])
    expect(checkIns.every((c) => c.status === "checked_in" && c.kind === "attendee")).toBe(true)
  })

  it("opens a session for every check-in, last seen now (so the room counts them inside)", () => {
    expect(sessions).toHaveLength(checkIns.length)
    expect(sessions.every((s) => s.departed_at == null && (s.last_seen_at as Date).getTime() === NOW.getTime())).toBe(true)
  })

  it("lists, as Friends here, 60 of a target's friends and 4 in the second room: all opted in", () => {
    const listable = listableFriends(layout)
    const slices = friendSlices(layout.targets[0].friends)
    expect(slices.bigRoom).toHaveLength(60)
    expect(slices.secondRoom).toHaveLength(4)
    expect([...slices.bigRoom, ...slices.secondRoom].every((i) => listable.has(i))).toBe(true)
    expect(slices.dm.every((i) => !listable.has(i))).toBe(true)
  })

  it("leaves out a target who already has a row of their own there", () => {
    const skipped = roomRows(layout, targets, NOW, big, second, new Set([`${big.occurrenceId}:target1`]))
    expect(skipped.checkIns.some((c) => c.user_id === "target1")).toBe(false)
    expect(skipped.sessions.some((s) => s.user_id === "target1")).toBe(false)
    expect(skipped.checkIns).toHaveLength(checkIns.length - 1)
  })
})

describe("the board", () => {
  it("is past the 100-post page, by people in the room, newest distinct", () => {
    const posts = boardRows(layout, big, NOW)
    expect(posts).toHaveLength(BOARD_POSTS)
    expect(BOARD_POSTS).toBeGreaterThan(100)
    expect(duplicates(posts.map((p) => p.body))).toEqual([])
    expect(posts.every((p) => p.event_id === big.eventId && (p.author_id as string).startsWith(ID_PREFIX))).toBe(true)
  })
})

describe("the entry point refuses a database that is neither staging nor local", () => {
  const SCRIPT = join(__dirname, "..", "scripts", "seed-qa-scale.ts")
  const run = (env: Record<string, string>, ...args: string[]) => {
    try {
      const stdout = execFileSync("npx", ["tsx", SCRIPT, ...args], {
        env: { ...process.env, RAILWAY_ENVIRONMENT_NAME: "", DATABASE_URL: "", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      })
      return { status: 0, stdout, stderr: "" }
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string }
      return { status: e.status, stdout: e.stdout, stderr: e.stderr }
    }
  }

  it.each([
    ["production", { RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: "postgresql://u:p@db.internal:5432/blendn" }],
    ["an unknown remote host", { DATABASE_URL: "postgresql://u:p@db.example.com:5432/blendn" }],
  ])("--apply on %s writes nothing and says why", (_label, env) => {
    const result = run(env, "--apply")
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/REFUSING: .*neither staging nor a local database/)
    expect(result.stdout).not.toMatch(/APPLY/)
  })

  it("refuses --remove and the dry run there too", () => {
    const env = { DATABASE_URL: "postgresql://u:p@db.example.com:5432/blendn" }
    expect(run(env, "--remove").status).toBe(1)
    expect(run(env).status).toBe(1)
  })
})
