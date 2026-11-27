/**
 * Accounts known to be under 18 (SCRUM-1169, D-026), on a real database:
 * `--apply` stamps each one once, the 14-day list reads the stamp, and a
 * staff correction sets the birth date, clears the stamp and leaves an audit
 * row. Ids only: the script prints nothing else.
 */
import { correctBirthDate, DELETE_AFTER_DAYS, dueForDeletion, knownMinorsUnstamped, stampKnownMinors } from "@/scripts/under-18-accounts"
import { cleanup, closeDb, db, makeUser } from "./helpers"

const DAY_MS = 86_400_000
const users: string[] = []
let ADMIN = ""
let ADMIN_ID = ""
beforeAll(async () => {
  ADMIN_ID = await makeUser("u18-admin", "app_admin")
  users.push(ADMIN_ID)
  ADMIN = `${ADMIN_ID}@matrixsociallabs.com`
  await db.user.update({ where: { id: ADMIN_ID }, data: { email: ADMIN } })
})
afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: users } }, { user_id: { in: users } }] } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

const yearsAgo = (n: number) => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - n)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

type Profile = { onboarded?: boolean; age?: number | null; date_of_birth?: Date | null; under_18_since?: Date | null }
async function person(label: string, profile: Profile) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({ data: { id, name: label, onboarded: true, ...profile } })
  return id
}
const stampOf = async (id: string) => (await db.profiles.findUniqueOrThrow({ where: { id }, select: { under_18_since: true } })).under_18_since

describe("stamping", () => {
  it("stamps a known age under 18, by birth date or by stored age, and nobody else", async () => {
    const byDob = await person("u18-dob16", { date_of_birth: yearsAgo(16) })
    const byAge = await person("u18-age17", { age: 17 })
    const adult = await person("u18-adult", { date_of_birth: yearsAgo(30) })
    const noAge = await person("u18-noage", {})
    // A stored 17 that a birth date of 25 years ago contradicts is an adult (`ageFrom` reads the date first).
    const grownUp = await person("u18-grown", { age: 17, date_of_birth: yearsAgo(25) })
    const deleted = await person("u18-deleted", { age: 16 })
    await db.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })

    const now = new Date()
    const ids = await stampKnownMinors(db, now)
    expect(ids).toEqual(expect.arrayContaining([byDob, byAge]))
    for (const id of [adult, noAge, grownUp, deleted]) expect(ids).not.toContain(id)
    expect(await stampOf(byDob)).toEqual(now)
    expect(await stampOf(byAge)).toEqual(now)
    for (const id of [adult, noAge, grownUp, deleted]) expect(await stampOf(id)).toBeNull()
  })

  it("is idempotent: a second run stamps nobody it stamped, and the first time stands", async () => {
    const teen = await person("u18-twice", { age: 15 })
    const earlier = new Date(Date.now() - 9 * DAY_MS)
    const preStamped = await person("u18-prestamped", { age: 15, under_18_since: earlier })
    const first = new Date(Date.now() - 3 * DAY_MS)
    await stampKnownMinors(db, first)
    const again = await stampKnownMinors(db, new Date())
    expect(again).not.toContain(teen)
    expect(await stampOf(teen)).toEqual(first)
    expect(await stampOf(preStamped)).toEqual(earlier)
    expect(await knownMinorsUnstamped(db, new Date())).not.toContain(teen)
  })
})

describe("the deletion list", () => {
  it(`lists an account stamped ${DELETE_AFTER_DAYS} or more days ago, and not one stamped since or deleted`, async () => {
    const now = new Date()
    const due = await person("u18-due", { age: 16, under_18_since: new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS) })
    const longDue = await person("u18-longdue", { age: 16, under_18_since: new Date(now.getTime() - 40 * DAY_MS) })
    const notYet = await person("u18-notyet", { age: 16, under_18_since: new Date(now.getTime() - (DELETE_AFTER_DAYS - 1) * DAY_MS) })
    const gone = await person("u18-gone", { under_18_since: new Date(now.getTime() - 40 * DAY_MS) })
    await db.user.update({ where: { id: gone }, data: { deletedAt: now } })

    const ids = await dueForDeletion(db, now)
    expect(ids).toEqual(expect.arrayContaining([due, longDue]))
    expect(ids).not.toContain(notYet)
    expect(ids).not.toContain(gone)
  })
})

describe("a staff correction", () => {
  it("sets the birth date and its age, clears the stamp, and writes an audit row naming who", async () => {
    const stampedAt = new Date(Date.now() - 3 * DAY_MS)
    const id = await person("u18-wrong", { age: 16, under_18_since: stampedAt })
    await correctBirthDate(db, { userId: id, dateOfBirth: "1995-06-15", by: ADMIN.toUpperCase() }, new Date())

    const row = await db.profiles.findUniqueOrThrow({ where: { id }, select: { date_of_birth: true, age: true, under_18_since: true } })
    expect(row.date_of_birth?.toISOString().slice(0, 10)).toBe("1995-06-15")
    expect(row.age).toBeGreaterThanOrEqual(30)
    expect(row.under_18_since).toBeNull()
    expect(await knownMinorsUnstamped(db, new Date())).not.toContain(id)

    const audit = await db.audit_logs.findFirstOrThrow({ where: { resource_id: id, action: "profile.under_18_corrected" } })
    expect(audit.user_id).toBe(ADMIN_ID)
    expect(audit.details).toMatchObject({ stampedAt: stampedAt.toISOString() })
    // The audit row names who and what changed, never the birth date itself.
    expect(JSON.stringify(audit.details)).not.toContain("1995")
  })

  it("refuses a birth date under 18, or not a date, and changes nothing", async () => {
    const stampedAt = new Date()
    const id = await person("u18-still", { age: 16, under_18_since: stampedAt })
    await expect(
      correctBirthDate(db, { userId: id, dateOfBirth: yearsAgo(17).toISOString().slice(0, 10), by: ADMIN }, new Date())
    ).rejects.toThrow(/18 and over/)
    await expect(correctBirthDate(db, { userId: id, dateOfBirth: "1995-02-30", by: ADMIN }, new Date())).rejects.toThrow(
      /real date/
    )
    expect(await stampOf(id)).toEqual(stampedAt)
    expect(await db.audit_logs.count({ where: { resource_id: id } })).toBe(0)
  })

  it("refuses an actor who is not a live app_admin, and changes nothing", async () => {
    const stampedAt = new Date()
    const id = await person("u18-actor", { age: 16, under_18_since: stampedAt })
    await expect(correctBirthDate(db, { userId: id, dateOfBirth: "1995-06-15", by: "nobody@matrixsociallabs.com" }, new Date())).rejects.toThrow(/app_admin/)
    expect(await stampOf(id)).toEqual(stampedAt)
  })

  it("refuses a deleted or unknown account", async () => {
    const id = await person("u18-erased", { under_18_since: new Date() })
    await db.user.update({ where: { id }, data: { deletedAt: new Date() } })
    await expect(correctBirthDate(db, { userId: id, dateOfBirth: "1995-06-15", by: ADMIN }, new Date())).rejects.toThrow(
      /No live account/
    )
    await expect(
      correctBirthDate(db, { userId: "00000000-0000-4000-8000-000000001169", dateOfBirth: "1995-06-15", by: ADMIN }, new Date())
    ).rejects.toThrow(/No live account/)
  })
})
