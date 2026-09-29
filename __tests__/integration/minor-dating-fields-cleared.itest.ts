import { readFileSync } from "fs"
import { Client } from "pg"
import { join } from "path"

/*
 * What a minor told us before the gates existed is cleared (SCRUM-477).
 *
 * SCRUM-200 and SCRUM-294 refuse orientation, "interested in", the consent to
 * show them and the dating choice under 18, and strip them when an age
 * correction drops below 18. Both act on a write. Rows written before them kept
 * the values: staging had a 17-year-old with an orientation, "interested in"
 * and looking_for "Dating". The migration applies the same clear to every row
 * whose age is known to be under 18, by `ageFrom`'s rule, and touches nothing
 * else.
 */
import { cleanup, closeDb, db, makeUser } from "./helpers"

const users: string[] = []
afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

/** As Prisma applies it: the whole script in one round trip. */
async function migrate() {
  const sql = readFileSync(
    join(__dirname, "../../prisma/migrations/20260929210000_minor_dating_fields_cleared/migration.sql"),
    "utf8"
  )
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** A UTC calendar day, `years` and `days` from today — the clock `ageFrom` counts on. */
const day = (years: number, days = 0) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), now.getUTCDate() + days))
}

type Fields = {
  orientations?: string[]
  interested_in?: string[]
  show_orientation?: boolean
  looking_for?: string[]
  intent_default?: ("dating" | "friendship" | "networking" | "just_here")[]
}

/** Everything dating-shaped filled in, as a row could be written before the gates. */
const FULL: Required<Fields> = {
  orientations: ["gay", "bisexual"],
  interested_in: ["man"],
  show_orientation: true,
  // Dating as a word goes, however it was written, with JS `\b`'s ASCII
  // boundaries ("datingß" is a word boundary there); a word that only contains it stays.
  looking_for: ["Dating", "casual dating", "Dating-app", "datingß", "Friends", "updating my playlist", "datingapp"],
  intent_default: ["dating", "friendship"],
}
const CLEARED = {
  orientations: [],
  interested_in: [],
  show_orientation: false,
  looking_for: ["Friends", "updating my playlist", "datingapp"],
  intent_default: ["friendship"],
}

async function person(label: string, age: { age?: number; dob?: Date }, fields: Fields = FULL) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({
    data: {
      id,
      name: label,
      bio: `${label} bio`,
      age: age.age ?? null,
      date_of_birth: age.dob ?? null,
      orientations: fields.orientations ?? [],
      interested_in: fields.interested_in ?? [],
      show_orientation: fields.show_orientation ?? false,
      looking_for: fields.looking_for ?? [],
      intent_default: fields.intent_default ?? [],
    },
  })
  return id
}

const read = (id: string) =>
  db.profiles.findUniqueOrThrow({
    where: { id },
    select: { orientations: true, interested_in: true, show_orientation: true, looking_for: true, intent_default: true },
  })
const rest = (id: string) =>
  db.profiles.findUniqueOrThrow({ where: { id }, select: { name: true, bio: true, age: true, date_of_birth: true } })
/** Changes on any UPDATE of the row, so it tells a rewrite from a row left alone. */
const version = async (id: string) =>
  (await db.$queryRaw<{ v: string }[]>`SELECT xmin::text AS v FROM profiles WHERE id = ${id}`)[0].v

it("clears a minor's orientation, interested-in, consent and dating choices by ageFrom's rule, and nothing else", async () => {
  const cleared = {
    dob17: await person("mdf-dob17", { dob: day(-17) }),
    age16: await person("mdf-age16", { age: 16 }),
    // The birth date is the better fact and wins, both ways, as in `ageFrom`.
    dob17age30: await person("mdf-dob17-age30", { dob: day(-17), age: 30 }),
    // A birth date outside 0-149 years is corrupt, not informative: the stored age decides.
    futureAge16: await person("mdf-future-age16", { dob: day(2), age: 16 }),
    ancientAge16: await person("mdf-1800-age16", { dob: new Date(Date.UTC(1800, 0, 1)), age: 16 }),
    dob150age16: await person("mdf-150y-age16", { dob: day(-150), age: 16 }),
    // Eighteen tomorrow is seventeen today.
    eighteenTomorrow: await person("mdf-18-tomorrow", { dob: day(-18, 1) }),
  }
  const kept = {
    dob25age16: await person("mdf-dob25-age16", { dob: day(-25), age: 16 }),
    futureAge30: await person("mdf-future-age30", { dob: day(2), age: 30 }),
    // Months ahead is still the future: SQL's age() reads it as 0 years, `ageFrom` as none.
    soonAge30: await person("mdf-soon-age30", { dob: day(0, 90), age: 30 }),
    soonUnknown: await person("mdf-soon-unknown", { dob: day(0, 1) }),
    dob25: await person("mdf-dob25", { dob: day(-25) }),
    age18: await person("mdf-age18", { age: 18 }),
    eighteenToday: await person("mdf-18-today", { dob: day(-18) }),
    // Unknown is not known to be a minor. The route strips it on a write; a
    // migration clearing every age-less adult's orientation would destroy data.
    unknown: await person("mdf-unknown", {}),
  }
  // One field each: every one of them is reason enough to clear the row.
  const single = {
    show: await person("mdf-only-show", { age: 16 }, { show_orientation: true }),
    orientations: await person("mdf-only-or", { age: 16 }, { orientations: ["gay"] }),
    interested: await person("mdf-only-int", { age: 16 }, { interested_in: ["man"] }),
    intent: await person("mdf-only-intent", { age: 16 }, { intent_default: ["dating"] }),
    looking: await person("mdf-only-looking", { age: 16 }, { looking_for: ["Dating"] }),
  }
  // The order someone chose in is theirs.
  const ordered = await person("mdf-order", { age: 16 }, { looking_for: ["Music", "Dating", "Art"] })
  // A minor with nothing dating-shaped is not rewritten at all.
  const clean = await person("mdf-clean", { age: 16 }, { looking_for: ["Friends"], intent_default: ["friendship"] })
  // Lists that were never written stay unwritten.
  const nulls = await person("mdf-nulls", { age: 16 }, { show_orientation: true })
  await db.$executeRaw`UPDATE profiles SET looking_for = NULL, intent_default = NULL WHERE id = ${nulls}`

  const restBefore = new Map(await Promise.all([cleared.dob17, kept.dob25].map(async (id) => [id, await rest(id)] as const)))
  const untouched = [...Object.values(kept), clean]
  const versionBefore = new Map(await Promise.all(untouched.map(async (id) => [id, await version(id)] as const)))

  await migrate()

  for (const [label, id] of Object.entries(cleared)) expect([label, await read(id)]).toEqual([label, CLEARED])
  for (const [label, id] of Object.entries(kept)) expect([label, await read(id)]).toEqual([label, FULL])
  for (const [label, id] of Object.entries(single)) {
    expect([label, await read(id)]).toEqual([
      label,
      { orientations: [], interested_in: [], show_orientation: false, looking_for: [], intent_default: [] },
    ])
  }
  expect((await read(ordered)).looking_for).toEqual(["Music", "Art"])
  // Read raw: Prisma hands a NULL list back as [], which would hide the difference.
  expect(
    await db.$queryRaw`SELECT show_orientation, looking_for IS NULL AS lf, intent_default IS NULL AS intent FROM profiles WHERE id = ${nulls}`
  ).toEqual([{ show_orientation: false, lf: true, intent: true }])
  // Only the five dating columns move.
  for (const [id, before] of restBefore) expect(await rest(id)).toEqual(before)
  for (const [id, before] of versionBefore) expect(await version(id)).toBe(before)

  // Run again, as a re-deploy would: nothing is rewritten.
  const cleanedVersion = await version(cleared.dob17)
  await migrate()
  expect(await version(cleared.dob17)).toBe(cleanedVersion)
  expect(await read(cleared.dob17)).toEqual(CLEARED)
})
