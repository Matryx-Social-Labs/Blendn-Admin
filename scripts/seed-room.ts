/**
 * A room you can actually test in: one long-running event with people in it.
 *
 *   SEED_ROOM=yes SEED_ROOM_PASSWORD=... DATABASE_URL=... npx tsx scripts/seed-room.ts
 *   SEED_ROOM=yes SEED_ROOM_PASSWORD=... DATABASE_URL=... npx tsx scripts/seed-room.ts --clean
 *   npm run seed:room
 *
 * Matching, the roster, the dating tag, the small-room floor and the work-field
 * suppression all need a *populated* room to be visible at all, and production
 * has never had one — `user_interests` was empty for weeks while every test
 * stayed green. This makes the room, so the failures are on a screen instead of
 * in a query plan.
 *
 * ## Two guards, because one of them protects nothing
 *
 * `seed-volume.ts` refuses to run against a database with more than 1000 users.
 * On staging *and* on production that check passes, so it protects neither.
 * This requires `SEED_ROOM=yes` explicitly **and** prints the host it resolved
 * from `DATABASE_URL` before writing anything — the two databases differ only
 * by credentials on the same internal hostname, which is exactly how the wrong
 * one gets seeded.
 *
 * ## One occurrence, spanning all thirty days
 *
 * `syncOccurrences` splits a long span into one row per local day, and check-in
 * resolves *today's* occurrence. Thirty rows would be correct for a real
 * thirty-day festival and useless here: a tester on day twelve would land on an
 * occurrence with no check-ins and an empty room. One hand-written occurrence
 * covering the whole span keeps everybody in the same room for a month.
 *
 * That is a deliberate deviation from what the product would create, and the
 * only one in this file.
 *
 * ## What the shape is for
 *
 * Not "25 random users". Each cluster exists to make one thing visible:
 *
 * - **Interest clusters** so match bands vary rather than all reading the same.
 * - **Three people with one interest and two with none**, because a room where
 *   everyone is richly tagged hides how the empty case looks.
 * - **Mixed intents including silence and `just_here`**, which score alike —
 *   the fix in #183 is only observable with both present.
 * - **A dating cohort** covering compatible, incompatible, undeclared and the
 *   non-binary direct-selection path, plus one under-18 to prove the age gate.
 * - **Mixed `work_field`**, some shared, to see the tiebreak and the label.
 * - **~6 revealed**, so the reveal rule is visible next to people it does not
 *   apply to.
 * - **Three friend clusters** — near-identical interests, check-ins within a
 *   minute. There is **no group model in the schema** (`chat_groups.event_id`
 *   is `@unique`), so this is a data *shape* for a future group matcher and
 *   nothing reads it as a group today.
 *
 * ## Idempotent
 *
 * Everything is namespaced `roomseed`. Re-running upserts rather than
 * duplicating, and `--clean` removes exactly what it added.
 */
import { generateUniqueAnonymousName } from "../lib/anonymous-names"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const TAG = "roomseed"

/**
 * What a *real* pseudonym looks like: "Cosmic Panda", or "Cosmic Panda 2" when
 * the generator had to disambiguate.
 *
 * An allowlist, not a blocklist, and that is the point. The first attempt at
 * this matched the old leaky shape `handle-xxxx` — and missed `friendB-endB`
 * (uppercase) and `kid-_kid` (underscore), leaving two people's handles in the
 * room. Enumerating the ways a name can be wrong is a losing game; there is
 * exactly one way for it to be right.
 */
const GENERATED = /^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/
const EVENT_SLUG = `${TAG}-thirty-day-room`
const DAYS = 30

/** Bengaluru — the launch city, and where the review account's event sits. */
const CITY = {
  name: "Bengaluru",
  state: "Karnataka",
  country: "India",
  latitude: 12.9721,
  longitude: 77.5938,
  timezone: "Asia/Kolkata",
}

/**
 * Required, with no default, and deliberately not printed.
 *
 * This was a constant in this file — and the day the repository went public,
 * twenty-five accounts on a reachable host had a password anybody could read,
 * with predictable addresses (`roomseed-aisha@blendn.invalid`) and the hostname
 * documented two directories away. Fake data on a separate database, so the
 * blast radius was small; an open door either way, and one this file created.
 *
 * A hardcoded credential is only ever as private as the least private place the
 * code ends up, which is not a property you can check at the time you write it.
 */
const PASSWORD = process.env.SEED_ROOM_PASSWORD

/**
 * A fixed id so re-seeding updates the organisation rather than accumulating a
 * new one each run. `organisations` has no natural unique key to upsert on —
 * `display_name` is not unique, and should not be.
 *
 * Spelled `5eed…` so it is recognisable as seed data in a table someone is
 * scanning by eye, and in a foreign key on an event.
 */
const ORG_ID = "5eed0000-0000-4000-8000-000000000001"

type Gender = "woman" | "man" | "non_binary" | "prefer_not_to_say"
type Intent = "dating" | "networking" | "friendship" | "just_here"

interface Person {
  handle: string
  name: string
  age: number
  gender: Gender | null
  orientations: string[]
  interestedIn: Gender[]
  intents: Intent[]
  workField: string | null
  revealed: boolean
  /** Index into the interest pool. Same cluster → same interests. */
  cluster: number
  /** How many interests to take from the cluster. 0 means none at all. */
  interestCount: number
  /** Minutes after the event start that they checked in. */
  arrivedAfterMin: number
  note: string
}

/*
 * Twenty-five people, each here for a reason.
 *
 * The `note` is not decoration: when a match list looks wrong on a phone, the
 * first question is "who are these people supposed to be", and the answer
 * should not require reading the seeding logic.
 */
const PEOPLE: Person[] = [
  // Dating cohort — straight, compatible both ways.
  { handle: "aisha", name: "Aisha Menon", age: 27, gender: "woman", orientations: ["straight"], interestedIn: ["man"], intents: ["dating", "networking"], workField: "design", revealed: true, cluster: 0, interestCount: 4, arrivedAfterMin: 5, note: "straight woman, dating — matches rohan/vikram" },
  { handle: "rohan", name: "Rohan Bhat", age: 29, gender: "man", orientations: ["straight"], interestedIn: ["woman"], intents: ["dating"], workField: "software", revealed: false, cluster: 0, interestCount: 4, arrivedAfterMin: 8, note: "straight man, dating — matches aisha/priya" },
  { handle: "vikram", name: "Vikram Rao", age: 31, gender: "man", orientations: ["straight"], interestedIn: ["woman"], intents: ["dating", "friendship"], workField: "finance", revealed: false, cluster: 1, interestCount: 3, arrivedAfterMin: 12, note: "straight man — NOT a dating match for rohan, still shares interests" },
  { handle: "priya", name: "Priya Raman", age: 26, gender: "woman", orientations: ["straight"], interestedIn: ["man"], intents: ["dating"], workField: "product", revealed: true, cluster: 1, interestCount: 3, arrivedAfterMin: 15, note: "straight woman, dating" },

  // Dating cohort — gay, lesbian, bisexual, non-binary, undeclared.
  { handle: "arjun", name: "Arjun Iyer", age: 30, gender: "man", orientations: ["gay"], interestedIn: ["man"], intents: ["dating", "friendship"], workField: "media", revealed: false, cluster: 2, interestCount: 4, arrivedAfterMin: 20, note: "gay man — matches nikhil, not rohan" },
  { handle: "nikhil", name: "Nikhil Shetty", age: 28, gender: "man", orientations: ["gay"], interestedIn: ["man"], intents: ["dating"], workField: "software", revealed: false, cluster: 2, interestCount: 4, arrivedAfterMin: 22, note: "gay man — mutual with arjun" },
  { handle: "leela", name: "Leela Fernandes", age: 32, gender: "woman", orientations: ["lesbian"], interestedIn: ["woman"], intents: ["dating"], workField: "healthcare", revealed: true, cluster: 3, interestCount: 3, arrivedAfterMin: 25, note: "lesbian — matches meera, not aisha (aisha is straight)" },
  { handle: "meera", name: "Meera Kulkarni", age: 29, gender: "woman", orientations: ["bisexual"], interestedIn: ["woman", "man", "non_binary"], intents: ["dating", "networking"], workField: "arts", revealed: false, cluster: 3, interestCount: 3, arrivedAfterMin: 28, note: "bisexual — mutual with leela; one-way toward straight women" },
  { handle: "sam", name: "Sam Dcruz", age: 27, gender: "non_binary", orientations: ["queer"], interestedIn: ["woman", "non_binary"], intents: ["dating", "friendship"], workField: "design", revealed: false, cluster: 4, interestCount: 2, arrivedAfterMin: 33, note: "non-binary + queer — derivation returns null, interested_in set DIRECTLY" },
  { handle: "dev", name: "Dev Anand", age: 34, gender: null, orientations: [], interestedIn: [], intents: ["dating"], workField: "consulting", revealed: false, cluster: 4, interestCount: 2, arrivedAfterMin: 36, note: "ticked dating, declared nothing — fails closed, no tag anywhere" },

  // The age gate.
  { handle: "kid", name: "Ravi Junior", age: 17, gender: "man", orientations: ["straight"], interestedIn: ["woman"], intents: ["friendship"], workField: "student", revealed: false, cluster: 5, interestCount: 3, arrivedAfterMin: 40, note: "17 — the server must refuse dating intent for this account" },

  // Networking-heavy, shared work fields, to exercise the tiebreak.
  { handle: "ananya", name: "Ananya Gupta", age: 33, gender: "woman", orientations: [], interestedIn: [], intents: ["networking"], workField: "software", revealed: true, cluster: 5, interestCount: 3, arrivedAfterMin: 44, note: "networking only — shares work_field with rohan/nikhil/karthik" },
  { handle: "karthik", name: "Karthik Subramanian", age: 36, gender: "man", orientations: [], interestedIn: [], intents: ["networking"], workField: "software", revealed: false, cluster: 6, interestCount: 4, arrivedAfterMin: 47, note: "networking, software" },
  { handle: "fatima", name: "Fatima Sheikh", age: 30, gender: "woman", orientations: [], interestedIn: [], intents: ["networking", "friendship"], workField: "data_ai", revealed: true, cluster: 6, interestCount: 4, arrivedAfterMin: 51, note: "networking + friendship" },
  { handle: "joseph", name: "Joseph Mathew", age: 41, gender: "man", orientations: [], interestedIn: [], intents: ["networking"], workField: "finance", revealed: false, cluster: 7, interestCount: 3, arrivedAfterMin: 55, note: "networking, finance — shares field with vikram" },

  // Silence and just_here — these two score alike, which is the point of #183.
  { handle: "quiet1", name: "Nandini Rao", age: 25, gender: null, orientations: [], interestedIn: [], intents: [], workField: null, revealed: false, cluster: 7, interestCount: 3, arrivedAfterMin: 60, note: "no intent at all — must rank level with the just_here group" },
  { handle: "quiet2", name: "Sanjay Pillai", age: 38, gender: null, orientations: [], interestedIn: [], intents: [], workField: "operations", revealed: false, cluster: 8, interestCount: 2, arrivedAfterMin: 64, note: "no intent, has a work field" },
  { handle: "justhere1", name: "Tara Bose", age: 24, gender: null, orientations: [], interestedIn: [], intents: ["just_here"], workField: null, revealed: false, cluster: 8, interestCount: 2, arrivedAfterMin: 68, note: "just_here — damped exactly like silence" },
  { handle: "justhere2", name: "Imran Qureshi", age: 35, gender: null, orientations: [], interestedIn: [], intents: ["just_here"], workField: "hospitality", revealed: false, cluster: 9, interestCount: 1, arrivedAfterMin: 72, note: "just_here, one interest" },
  { handle: "justhere3", name: "Kavya Nair", age: 28, gender: null, orientations: [], interestedIn: [], intents: ["just_here", "networking"], workField: "marketing", revealed: true, cluster: 9, interestCount: 1, arrivedAfterMin: 76, note: "just_here PLUS networking — must NOT be damped" },

  // Sparse and empty interests.
  { handle: "sparse1", name: "Yusuf Ali", age: 31, gender: null, orientations: [], interestedIn: [], intents: ["friendship"], workField: "education", revealed: false, cluster: 10, interestCount: 1, arrivedAfterMin: 80, note: "exactly one interest" },
  { handle: "empty1", name: "Divya Prasad", age: 27, gender: null, orientations: [], interestedIn: [], intents: ["friendship"], workField: null, revealed: false, cluster: 0, interestCount: 0, arrivedAfterMin: 84, note: "NO interests — the production default; card must still render" },
  { handle: "empty2", name: "Manoj Kumar", age: 45, gender: null, orientations: [], interestedIn: [], intents: ["networking"], workField: "government_ngo", revealed: false, cluster: 0, interestCount: 0, arrivedAfterMin: 88, note: "no interests, has intent and a work field" },

  // Friend cluster three — near-identical interests, arriving together.
  { handle: "friendA", name: "Neha Joshi", age: 26, gender: "woman", orientations: ["straight"], interestedIn: ["man"], intents: ["friendship"], workField: "design", revealed: true, cluster: 11, interestCount: 4, arrivedAfterMin: 90, note: "arrives with friendB/friendC — group-matcher data shape only" },
  { handle: "friendB", name: "Pooja Desai", age: 25, gender: "woman", orientations: ["straight"], interestedIn: ["man"], intents: ["friendship"], workField: "marketing", revealed: false, cluster: 11, interestCount: 4, arrivedAfterMin: 90, note: "arrives with friendA/friendC" },
]

/** Interest pool, grouped so clusters overlap heavily and across clusters little. */
async function interestPool(): Promise<string[][]> {
  const leaves = await db.categories.findMany({
    where: { parent_id: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true },
  })
  if (leaves.length < 8) {
    throw new Error(
      `only ${leaves.length} leaf categories exist — run the category seed first, or matching has nothing to rank on`
    )
  }
  const ids = leaves.map((l) => l.id)
  // Twelve overlapping windows over the leaf list. Adjacent clusters share
  // categories, distant ones share none — which is what makes bands vary.
  return Array.from({ length: 12 }, (_, i) => {
    const start = (i * 2) % Math.max(1, ids.length - 4)
    return ids.slice(start, start + 4)
  })
}

function userId(handle: string): string {
  return `${TAG}_${handle}`
}

async function clean() {
  console.log("removing roomseed data...")
  const ids = PEOPLE.map((p) => userId(p.handle))
  const event = await db.events.findUnique({ where: { slug: EVENT_SLUG }, select: { id: true } })

  if (event) {
    await db.chat_messages.deleteMany({ where: { chat_group: { event_id: event.id } } })
    await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: event.id } } })
    await db.chat_groups.deleteMany({ where: { event_id: event.id } })
    await db.event_match_preferences.deleteMany({ where: { event_id: event.id } })
    await db.event_check_ins.deleteMany({ where: { event_id: event.id } })
    await db.event_occurrences.deleteMany({ where: { event_id: event.id } })
    await db.events.delete({ where: { id: event.id } })
  }

  await db.user_interests.deleteMany({ where: { user_id: { in: ids } } })
  await db.profiles.deleteMany({ where: { id: { in: ids } } })
  await db.user.deleteMany({ where: { id: { in: ids } } })
  await db.user.deleteMany({ where: { id: `${TAG}_organiser` } })
  // Members cascade from the user delete above; the organisation does not, so
  // it would survive --clean and be re-adopted by the next run with whatever
  // state it had drifted into.
  await db.organisations.deleteMany({ where: { id: ORG_ID } })
  console.log("done.")
}

async function main() {
  /*
   * Say which database this is about to write to, before writing to it.
   *
   * Staging and production sit on the same internal hostname and differ only by
   * credentials, so "I checked the URL" is not a control. Printing the resolved
   * host and database name is.
   */
  const url = new URL(process.env.DATABASE_URL!)
  console.log(`target: ${url.host}${url.pathname}  (user: ${url.username})`)

  if (!PASSWORD || PASSWORD.length < 12) {
    console.error(
      "REFUSING: set SEED_ROOM_PASSWORD to at least 12 characters.\n" +
        "There is no default on purpose — see the comment above the constant."
    )
    process.exit(1)
  }

  if (process.env.SEED_ROOM !== "yes") {
    console.error(
      "REFUSING: set SEED_ROOM=yes to confirm. This writes 25 accounts and an event.\n" +
        "Staging only — check the target line above before you do."
    )
    process.exit(1)
  }

  if (process.argv.includes("--clean")) {
    await clean()
    return
  }

  const pool = await interestPool()
  const hashed = await bcrypt.hash(PASSWORD, 10)

  /*
   * The organiser needs THREE things to be usable, and having one or two of
   * them fails in a way that reads like a broken dashboard rather than a
   * missing row.
   *
   *   1. a password       — without it there is no way to sign in at all
   *   2. an organisation   — `status: verified`; pending and suspended are not
   *                          working hosts
   *   3. a membership row  — `lib/org-membership.ts` builds `orgIds` from it,
   *                          and `eventPermissions` returns DENIED on an empty
   *                          set before it looks at the event
   *
   * Miss (3) and the sign-in *succeeds* and the dashboard is empty. That is the
   * expensive one: an empty page looks like a bug in the page.
   *
   * The password is re-asserted on update, like the attendees, so re-running
   * with a fresh SEED_ROOM_PASSWORD moves every account including this one.
   */
  const organiser = await db.user.upsert({
    where: { id: `${TAG}_organiser` },
    update: { password: hashed, emailVerified: new Date() },
    create: {
      id: `${TAG}_organiser`,
      email: `${TAG}-organiser@blendn.invalid`,
      name: "Room Seed Organiser",
      role: "organizer",
      password: hashed,
      emailVerified: new Date(),
    },
  })

  const org = await db.organisations.upsert({
    where: { id: ORG_ID },
    update: { status: "verified" },
    create: {
      id: ORG_ID,
      kind: "company",
      display_name: "Seed Events Co (seed)",
      legal_name: "Seed Events Private Limited",
      status: "verified",
      verified_at: new Date(),
      address: `MG Road, ${CITY.name}`,
    },
  })

  await db.organisation_members.upsert({
    where: { org_id_user_id: { org_id: org.id, user_id: organiser.id } },
    update: {},
    create: {
      org_id: org.id,
      user_id: organiser.id,
      role: "owner",
      is_primary_contact: true,
    },
  })

  const start = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + DAYS * 24 * 60 * 60 * 1000)

  const event = await db.events.upsert({
    where: { slug: EVENT_SLUG },
    // `organizer_org_id` is re-asserted on update so an event seeded before
    // this script grew an organisation picks one up on the next run, rather
    // than staying uneditable for reasons nothing on screen explains.
    update: {
      start_time: start,
      end_time: end,
      status: "published",
      organizer_org_id: org.id,
    },
    create: {
      slug: EVENT_SLUG,
      title: "The Long Room (seed)",
      description:
        "A test event that runs for thirty days so the room stays populated. " +
        "Seeded by scripts/seed-room.ts — not a real event.",
      short_description: "Seeded test room, 30 days",
      latitude: CITY.latitude,
      longitude: CITY.longitude,
      address: `MG Road, ${CITY.name}`,
      venue_name: "Seed Venue",
      city: CITY.name,
      state: CITY.state,
      country: CITY.country,
      start_time: start,
      end_time: end,
      timezone: CITY.timezone,
      status: "published",
      visibility: "public",
      max_capacity: 200,
      organizer_id: organiser.id,
      // Who created it vs. which org is accountable. `eventPermissions` reads
      // the second one, never the first.
      organizer_org_id: org.id,
      // Wide enough that a simulator anywhere in central Bengaluru is inside.
      check_in_radius: 2000,
    },
  })

  /*
   * ONE occurrence spanning the whole month — see the header.
   *
   * `syncOccurrences` would create thirty, and check-in resolves today's, so a
   * tester on day twelve would find an empty room. Written directly rather than
   * through the helper because this is the one place the seed deliberately
   * disagrees with what the product would produce.
   */
  const existingOccurrence = await db.event_occurrences.findFirst({
    where: { event_id: event.id },
    select: { id: true },
  })
  const occurrence =
    existingOccurrence ??
    (await db.event_occurrences.create({
      data: {
        event_id: event.id,
        occurs_on: new Date(start.toISOString().slice(0, 10) + "T00:00:00Z"),
        start_time: start,
        end_time: end,
      },
      select: { id: true },
    }))

  const chatGroup = await db.chat_groups.upsert({
    where: { event_id: event.id },
    update: {},
    create: { event_id: event.id, name: "The Long Room Chat" },
  })

  let created = 0
  for (const person of PEOPLE) {
    const id = userId(person.handle)

    await db.user.upsert({
      where: { id },
      /*
       * The password is re-asserted, not just set on create.
       *
       * Otherwise re-running could never rotate a credential that had leaked —
       * which is exactly what was needed the day it did. `seed-review-account.ts`
       * re-asserts for the same reason.
       */
      update: { name: person.name, password: hashed },
      create: {
        id,
        email: `${TAG}-${person.handle}@blendn.invalid`,
        name: person.name,
        password: hashed,
        emailVerified: new Date(),
        role: "attendee",
      },
    })

    /*
     * Under-18 accounts never carry dating intent, even where the seed data
     * says otherwise — the server refuses it on every write path, and a seed
     * that inserts a state the API cannot produce is a seed that makes the next
     * bug hunt longer.
     */
    const intents = person.age >= 18 ? person.intents : person.intents.filter((i) => i !== "dating")

    const profileFields = {
      name: person.name,
      age: person.age,
      location: CITY.name,
      bio: `Seeded account. ${person.note}`,
      onboarded: true,
      intent_default: intents,
      reveal_by_default: person.revealed,
      gender: person.gender,
      orientations: person.orientations,
      interested_in: person.interestedIn,
      work_field: person.workField,
      photos: person.revealed ? [`https://i.pravatar.cc/300?u=${id}`] : [],
    }

    await db.profiles.upsert({
      where: { id },
      update: profileFields,
      create: { id, ...profileFields },
    })

    const categoryIds = pool[person.cluster % pool.length].slice(0, person.interestCount)
    await db.user_interests.deleteMany({ where: { user_id: id } })
    if (categoryIds.length > 0) {
      await db.user_interests.createMany({
        data: categoryIds.map((category_id) => ({ user_id: id, category_id })),
        skipDuplicates: true,
      })
    }

    const arrived = new Date(start.getTime() + person.arrivedAfterMin * 60 * 1000)

    await db.event_check_ins.upsert({
      where: { occurrence_id_user_id: { occurrence_id: occurrence.id, user_id: id } },
      update: { status: "checked_in", check_in_time: arrived },
      create: {
        event_id: event.id,
        occurrence_id: occurrence.id,
        user_id: id,
        kind: "attendee",
        status: "checked_in",
        check_in_time: arrived,
        latitude: CITY.latitude,
        longitude: CITY.longitude,
      },
    })

    await db.event_match_preferences.upsert({
      where: { event_id_user_id: { event_id: event.id, user_id: id } },
      update: { intent: intents, revealed: person.revealed },
      create: { event_id: event.id, user_id: id, intent: intents, revealed: person.revealed },
    })

    /*
     * Without a `chat_group_members` row there is no `anonymous_name`, and every
     * match card in the room reads "Attendee" — which looks like a bug in the
     * ranking rather than a gap in the seed.
     *
     * **The real generator, not a handle-derived string.** This built
     * `${handle}-${id.slice(-4)}`, which produced "rohan-ohan" for Rohan Bhat —
     * a pseudonym with his actual first name in it. Two things wrong with that,
     * and the second is worse:
     *
     * 1. The seeded data leaked identity on every card and in every DM.
     * 2. It made the seed useless for testing anonymity. A gate that correctly
     *    returns the stored pseudonym instead of `profiles.name` looks identical
     *    to a broken one when the stored pseudonym IS the name. Every anonymity
     *    check run against this data was incapable of failing.
     *
     * `generateUniqueAnonymousName` is what check-in and chat-join call, so the
     * seed now exercises the same path production does, and produces the same
     * shape of name ("Cosmic Panda").
     */
    const existingMember = await db.chat_group_members.findUnique({
      where: { chat_group_id_user_id: { chat_group_id: chatGroup.id, user_id: id } },
      select: { anonymous_name: true },
    })
    await db.chat_group_members.upsert({
      where: { chat_group_id_user_id: { chat_group_id: chatGroup.id, user_id: id } },
      // Re-seeding keeps the name somebody may already be talking to, unless it
      // is one of the old leaky ones.
      update: GENERATED.test(existingMember?.anonymous_name ?? "")
        ? {}
        : { anonymous_name: await generateUniqueAnonymousName(chatGroup.id) },
      create: {
        chat_group_id: chatGroup.id,
        user_id: id,
        anonymous_name: await generateUniqueAnonymousName(chatGroup.id),
      },
    })

    created += 1
  }

  const interestRows = await db.user_interests.count({
    where: { user_id: { in: PEOPLE.map((p) => userId(p.handle)) } },
  })

  console.log("")
  console.log(`event        "${event.title}" (${event.id})`)
  console.log(`slug         ${EVENT_SLUG}`)
  console.log(`runs         ${start.toISOString()} → ${end.toISOString()} (${DAYS} days, 1 occurrence)`)
  console.log(`geofence     ${CITY.latitude}, ${CITY.longitude} · 2000m`)
  console.log(`attendees    ${created} checked in, ${interestRows} interest rows`)
  console.log(`revealed     ${PEOPLE.filter((p) => p.revealed).length}`)
  // The address, never the password. It is in the environment of whoever ran
  // this, and printing it puts it in a scrollback and a CI log.
  console.log(`sign in as   ${TAG}-aisha@blendn.invalid … password: $SEED_ROOM_PASSWORD`)
  console.log("")
  console.log(`organiser    ${TAG}-organiser@blendn.invalid … same password`)
  console.log(`             org "${org.display_name}" (${org.id}), verified, owner`)
  console.log(`             dashboard: the event above should be EDITABLE, not just visible`)
  console.log("")
  console.log(`remove it    SEED_ROOM=yes npx tsx scripts/seed-room.ts --clean`)
}

main()
  .catch((e) => {
    console.error("Error:", e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
