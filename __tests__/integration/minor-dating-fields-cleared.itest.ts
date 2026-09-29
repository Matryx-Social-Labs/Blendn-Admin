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
 * whose age is known to be under 18, by `ageFrom`'s rule.
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

const yearsAgo = (n: number) => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - n)
  return d
}

/** A row as it could be written before the gates: everything dating-shaped filled in. */
async function person(label: string, age: { age?: number; dob?: Date }) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({
    data: {
      id,
      name: label,
      age: age.age ?? null,
      date_of_birth: age.dob ?? null,
      orientations: ["gay", "bisexual"],
      interested_in: ["man"],
      show_orientation: true,
      looking_for: ["Dating", "casual dating", "Friends", "updating my playlist"],
      intent_default: ["dating", "friendship"],
    },
  })
  return id
}

const read = (id: string) =>
  db.profiles.findUniqueOrThrow({
    where: { id },
    select: { orientations: true, interested_in: true, show_orientation: true, looking_for: true, intent_default: true },
  })

const CLEARED = {
  orientations: [],
  interested_in: [],
  show_orientation: false,
  // Dating as a word goes, however it was written; a word that only contains it stays.
  looking_for: ["Friends", "updating my playlist"],
  intent_default: ["friendship"],
}
const KEPT = {
  orientations: ["gay", "bisexual"],
  interested_in: ["man"],
  show_orientation: true,
  looking_for: ["Dating", "casual dating", "Friends", "updating my playlist"],
  intent_default: ["dating", "friendship"],
}

it("clears a minor's orientation, interested-in, consent and dating choices, and leaves adults and unknown ages alone", async () => {
  const minorByDob = await person("mdf-dob17", { dob: yearsAgo(17) })
  const minorByAge = await person("mdf-age16", { age: 16 })
  // The birth date is the better fact and wins, both ways, as in `ageFrom`.
  const dobOverAge = await person("mdf-dob17-age30", { dob: yearsAgo(17), age: 30 })
  const adultDobOverAge = await person("mdf-dob25-age16", { dob: yearsAgo(25), age: 16 })
  // A birth date in the future is corrupt, not informative: the stored age decides.
  const futureDobMinor = await person("mdf-future-age16", { dob: yearsAgo(-2), age: 16 })
  const futureDobAdult = await person("mdf-future-age30", { dob: yearsAgo(-2), age: 30 })
  const adult = await person("mdf-dob25", { dob: yearsAgo(25) })
  const eighteen = await person("mdf-age18", { age: 18 })
  // Unknown is not known to be a minor. The route strips it on a write; a
  // migration clearing every age-less adult's orientation would destroy data.
  const unknown = await person("mdf-unknown", {})

  await migrate()

  for (const id of [minorByDob, minorByAge, dobOverAge, futureDobMinor]) {
    expect(await read(id)).toEqual(CLEARED)
  }
  for (const id of [adultDobOverAge, futureDobAdult, adult, eighteen, unknown]) {
    expect(await read(id)).toEqual(KEPT)
  }

  // Run again, as a re-deploy would: nothing moves.
  await migrate()
  expect(await read(minorByDob)).toEqual(CLEARED)
  expect(await read(adult)).toEqual(KEPT)
})
