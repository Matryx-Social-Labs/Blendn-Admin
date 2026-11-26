import { db } from "./db"

/**
 * The accounts that hold this inbox. `identity_email` (migration SQL, SCRUM-1172) folds case, a `+tag`, and
 * Gmail's dots and googlemail.com, so `A.B+x@Gmail.com` and `ab@gmail.com` are one inbox; indexed.
 */
const holdersOf = (email: string) =>
  db.$queryRaw<{ suspended: boolean }[]>`
    SELECT "suspended_at" IS NOT NULL AS "suspended" FROM "User" WHERE identity_email("email") = identity_email(${email})`

/** Whether any account holds this inbox: sign-up answers it as a taken address. */
export async function inboxTaken(email: string): Promise<boolean> {
  return (await holdersOf(email)).length > 0
}

/** Whether a suspended account holds this inbox: Google and Apple refuse to create an account for it. */
export async function isSuspendedIdentity(email: string): Promise<boolean> {
  return (await holdersOf(email)).some((holder) => holder.suspended)
}
