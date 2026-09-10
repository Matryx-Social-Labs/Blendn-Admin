import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * A minimal profile write, against a real Postgres.
 *
 * `PUT /profiles/:userId` upserts, and its `create` branch passed seven bare
 * optionals — `name`, `phone`, `age`, `location`, `bio`, `occupation`,
 * `education`. Under `strictUndefinedChecks` an explicit `undefined` is a
 * runtime error, so **every profile write failed**: onboarding could not be
 * completed and no profile could be edited.
 *
 * The part worth remembering is why it broke updates too. **Prisma validates
 * both branches of an `upsert` before it runs**, so an invalid `create` fails an
 * update that would never have executed it. The `update` branch here was fully
 * converted and correct, and it made no difference.
 *
 * Invisible to `tsc` (the fields are optional) and to the unit suite (which
 * mocks `@/lib/db`), which is why this is an integration test.
 */
const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

/** The shape the route builds when one field arrives and the rest are absent. */
const minimalCreate = (id: string, name?: string) => ({
  where: { id },
  create: {
    id,
    ...(name !== undefined && { name }),
    interests: [],
    photos: [],
    goals: [],
    looking_for: [],
    onboarded: false,
  },
  update: { ...(name !== undefined && { name }) },
})

describe("writing a profile with almost nothing in it", () => {
  it("creates a row when only one field is supplied", async () => {
    const id = await makeUser(testId("pu-create"))
    users.push(id)
    await db.profiles.deleteMany({ where: { id } })

    await expect(db.profiles.upsert(minimalCreate(id, "Ada"))).resolves.toBeTruthy()
    const row = await db.profiles.findUnique({ where: { id } })
    expect(row?.name).toBe("Ada")
    expect(row?.onboarded).toBe(false)
  })

  it("creates a row when NO optional field is supplied at all", async () => {
    /*
     * The case that broke. Onboarding's first step sends one or two fields and
     * omits every other column in the table.
     */
    const id = await makeUser(testId("pu-empty"))
    users.push(id)
    await db.profiles.deleteMany({ where: { id } })

    await expect(db.profiles.upsert(minimalCreate(id))).resolves.toBeTruthy()
    expect((await db.profiles.findUnique({ where: { id } }))?.name).toBeNull()
  })

  it("updates an existing row without the create branch being reached", async () => {
    /*
     * The one that shows the real hazard. This never executes `create` — and it
     * still failed, because Prisma validates the whole invocation first.
     */
    const id = await makeUser(testId("pu-update"))
    users.push(id)

    await db.profiles.upsert(minimalCreate(id, "Before"))
    await expect(db.profiles.upsert(minimalCreate(id, "After"))).resolves.toBeTruthy()
    expect((await db.profiles.findUnique({ where: { id } }))?.name).toBe("After")
  })
})
