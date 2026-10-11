/**
 * Whether a dashboard session has ended (step 18 security review, M6).
 *
 * A dashboard session is a JWT with no row behind it, so nothing can delete
 * it; it ends when the account says so. This is the one rule, and every place
 * that turns a NextAuth cookie into a person reads it: the jwt callback
 * (`lib/auth.ts`, which every `getAuth()` runs through), `currentUser`
 * (`lib/current-user.ts`) and the socket handshake (`lib/socket-ops-auth.ts`).
 * Three copies of it were how the first version came to differ.
 *
 * No database import: the caller reads the account and passes it in, so a
 * read that fails is the caller's error, never an account that looks fine.
 */

export interface SessionClaims {
  sub?: string | null
  signedInAt?: unknown
  iat?: unknown
}

export interface AccountState {
  deletedAt: Date | null
  suspended_at: Date | null
  password_changed_at: Date | null
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * When this session last proved the password, in ms since the epoch, or null
 * when it cannot say.
 *
 * `signedInAt` is stamped at sign-in and carried through every refresh. A
 * session from before it existed has only `iat`, in seconds — and `iat` is
 * re-stamped on every re-encode, which is why the jwt callback writes this
 * value back as `signedInAt` the first time it sees such a session.
 */
export function provenAt(claims: SessionClaims): number | null {
  if (isTime(claims.signedInAt)) return claims.signedInAt
  if (isTime(claims.iat)) return claims.iat * 1000
  return null
}

/**
 * Ended when: there is no user, or no account; the account is deleted or
 * suspended; the session cannot say when it signed in; or the password
 * changed at or after that moment. A tie goes to the change — the same
 * millisecond, or for an `iat` the same second, cannot say which came first.
 */
export function isRevoked(claims: SessionClaims, account: AccountState | null): boolean {
  if (!claims.sub || !account) return true
  if (account.deletedAt !== null || account.suspended_at !== null) return true
  const proven = provenAt(claims)
  if (proven === null) return true
  const changed = account.password_changed_at
  if (changed === null) return false
  // Not a date is a read that forgot to select it: ended, not waved through.
  return !(changed instanceof Date) || proven <= changed.getTime()
}

/** Thrown by the jwt callback; NextAuth answers a throwing callback with no session. */
export class SessionEnded extends Error {
  constructor() {
    super("This dashboard session has ended.")
    this.name = "SessionEnded"
  }
}
