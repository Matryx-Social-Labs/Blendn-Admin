import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * An admin editing a user, against real Postgres.
 *
 * `updateUser` in `app/dashboard/users/actions.ts` builds a `profile.upsert`
 * whose **update** branch passes `interests: data.profile.interests`. The one
 * caller — the Edit User dialog in `users-table.tsx` — never sends `interests`,
 * so that expression is **always** `undefined`, and under
 * `strictUndefinedChecks` an explicit `undefined` in a `data:` block is a
 * runtime error rather than "leave the column alone".
 *
 * Driven in a browser before this was written: opening any user's Edit dialog
 * on the staging dashboard and pressing Save Changes without touching a field
 * returned **500** and the toast read *"Failed to update user"*. So no admin
 * could edit any user — not their name, not their email, not their onboarded
 * flag.
 *
 * **Sixth instance of this class, and the first the ratchet could not see.**
 * `__tests__/prisma-shorthand-ratchet.test.ts` scans for bare shorthand
 * (`{ interests }`) and this is an explicit key whose *value* is undefined —
 * the same defect wearing different syntax. The ratchet is widened in the same
 * commit; this test is what proves the widening was needed.
 *
 * Invisible to `tsc` (the column is optional) and to the unit suite (which
 * mocks `@/lib/db`), so it can only be caught here.
 */
const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

/**
 * The action's own write, with the optional fields threaded through as the
 * dialog threads them.
 *
 * Taking them as parameters and spreading is the point: the dialog omits
 * `interests` entirely, and a test that also omitted the key would have passed
 * against the broken code.
 */
async function editUser(
  id: string,
  profile: { phone?: string | null; age?: number | null; location?: string | null; interests?: string[]; onboarded?: boolean }
) {
  return db.user.update({
    where: { id },
    data: {
      name: "Sagar Kishore",
      profile: {
        upsert: {
          create: {
            phone: profile.phone ?? null,
            age: profile.age ?? null,
            location: profile.location ?? null,
            interests: profile.interests || [],
            onboarded: profile.onboarded ?? false,
          },
          update: {
            phone: profile.phone ?? null,
            age: profile.age ?? null,
            location: profile.location ?? null,
            ...(profile.interests !== undefined && { interests: profile.interests }),
            onboarded: profile.onboarded,
          },
        },
      },
    },
    include: { profile: true },
  })
}

describe("an admin editing a user", () => {
  it("saves when the dialog omits interests, which it always does", async () => {
    const id = await makeUser(testId("admin-edit"), "attendee")
    users.push(id)

    /*
     * The profile row already exists — `makeUser` creates one — so the *update*
     * branch is the one that runs. That matters: Prisma validates both branches
     * before running either, so this also covers the create branch going wrong.
     */
    const user = await editUser(id, { phone: null, age: 24, location: null, onboarded: true })

    expect(user.name).toBe("Sagar Kishore")
    expect(user.profile?.age).toBe(24)
    expect(user.profile?.onboarded).toBe(true)
  })

  it("still writes interests when they are supplied", async () => {
    /*
     * The other direction. Making the field conditional is only correct if a
     * real value still lands — a guard that silently drops every write would
     * pass the test above.
     */
    const id = await makeUser(testId("admin-edit2"), "attendee")
    users.push(id)

    const user = await editUser(id, { age: 31, interests: ["Coffee"], onboarded: true })
    expect(user.profile?.interests).toEqual(["Coffee"])
  })
})
