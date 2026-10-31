// Relative imports, as lib/auth.ts.
import { clientNetworkFrom } from "./client-ip"
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW } from "./constants"
import { forget, hit, release } from "./rate-limit-store"
import { SIGNIN_ACCOUNT_LOCKED, SIGNIN_RATE_LIMITED } from "./rbac"

/*
 * The dashboard sign-in limits, called from authorize() (lib/auth.ts) because
 * that is the one place every request path to a password check reaches. They
 * used to match the raw URL in the route, and a percent-encoded `%63redentials`
 * walked around them (security audit 2026-10-24, WEB H1).
 *
 * - Per network (the /64 for IPv6): 5 attempts in 15 minutes, every attempt
 *   counted, as before.
 * - Per email, from any network: 20 wrong passwords in 15 minutes AND 200 in
 *   24 hours. Only failures stay counted (an attempt is reserved up front and
 *   given back on success), and nothing but a completed password reset
 *   clears them (`clearSigninCounters`): a victim signing in does not reset a
 *   spray that is still going. A person on their own network is held to the
 *   network limit first, so an attacker has to bring four networks to lock an
 *   operator out, and the operator gets back in by resetting their password.
 *
 * The email key is the typed address whether or not it exists, so a cap is no
 * oracle. Past any limit the right password is refused too. Every counter is
 * fail-closed where Redis is configured. A (email, network) counter is left
 * out on purpose: the network limit always fires before it could, and a reset
 * could not clear it without scanning keys.
 */
const FAIL_CLOSED = { failClosed: true } as const

/** The longest address that can exist (RFC 5321). Longer is refused before it becomes a Redis key. */
export const MAX_EMAIL_LENGTH = 254

/*
 * A real cost-12 hash of nothing anyone knows. An unknown email is compared
 * against it so the response takes as long as a known one (audit L1: 0.25 s vs
 * 0.64 s named the accounts that exist). Both sign-in doors use it.
 */
export const DUMMY_HASH = "$2b$12$O.tIGjDT8kuGET3q.N9fd.iBNLaB2NnxO7PopJJfIp.ozxgF47CE2"
const PREFIX = "rl:auth:dashboard-signin"

export interface SigninKeys {
  network: string
  account: string
  accountDay: string
}

export function signinKeys(email: string, headers: Record<string, unknown> | undefined): SigninKeys {
  const network = clientNetworkFrom({
    get: (name) => (typeof headers?.[name] === "string" ? (headers[name] as string) : null),
  })
  return { network: `${PREFIX}:${network}`, account: `${PREFIX}:acct:${email}`, accountDay: `${PREFIX}:acct-day:${email}` }
}

/** The two per-email keys; the mobile door has no network key of its own here (it keeps its per-IP limit). */
export const emailKeysFor = (email: string) => ({ account: `${PREFIX}:acct:${email}`, accountDay: `${PREFIX}:acct-day:${email}` })

/**
 * Reserve a place in both per-email windows and throw SIGNIN_ACCOUNT_LOCKED when
 * either is over. Reserve-then-settle, not check-then-count: N parallel guesses
 * all reading "under the cap" before any counted would each get a bcrypt, so
 * the increment is the check. Shared by the dashboard and the mobile sign-in,
 * so a wrong password at either door is held against the same address.
 */
export async function refuseOverEmailLimits(keys: Pick<SigninKeys, "account" | "accountDay">): Promise<void> {
  const [recent, today] = await Promise.all([
    hit(keys.account, RATE_LIMIT_WINDOW.DASHBOARD_SIGNIN, FAIL_CLOSED),
    hit(keys.accountDay, RATE_LIMIT_WINDOW.DASHBOARD_SIGNIN_ACCOUNT_DAY, FAIL_CLOSED),
  ])
  if (recent.count > RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN_ACCOUNT || today.count > RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN_ACCOUNT_DAY) {
    throw new Error(SIGNIN_ACCOUNT_LOCKED)
  }
}

/**
 * Before the password is read: the network window, then (unless this browser is
 * a known device for the email) the per-email windows. The network goes first and
 * alone, so an attacker's refused attempts from one address never spend the email's.
 */
export async function refuseOverSigninLimits(keys: SigninKeys, knownDevice = false): Promise<void> {
  const byNetwork = await hit(keys.network, RATE_LIMIT_WINDOW.DASHBOARD_SIGNIN, FAIL_CLOSED)
  if (byNetwork.count > RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN) throw new Error(SIGNIN_RATE_LIMITED)
  if (!knownDevice) await refuseOverEmailLimits(keys)
}

/**
 * The right password: give the email's two reservations back, so only wrong
 * passwords stay counted. Releases, never clears -- a victim signing in does
 * not reset a spray that is still going. A known device reserved nothing.
 */
export async function settleSigninSuccess(keys: Pick<SigninKeys, "account" | "accountDay">, knownDevice = false): Promise<void> {
  if (knownDevice) return
  await Promise.all([release(keys.account), release(keys.accountDay)])
}

/**
 * The mobile door's own per-account window (10 in 15 minutes): its `rateLimit` key (stored under `rl:`). Failures only:
 * a right password gives its attempt back (`releaseMobileAccountAttempt`), and a reset forgets it (SCRUM-944 part 1).
 */
export const mobileAccountKey = (email: string) => `auth:signin:acct:${email.trim().toLowerCase()}`
const storedMobileAccountKey = (email: string) => `rl:${mobileAccountKey(email)}`

/** The right password at the mobile door: its attempt is not held against the account. */
export async function releaseMobileAccountAttempt(email: string): Promise<void> {
  await release(storedMobileAccountKey(email))
}

/** A completed password reset proved control of the mailbox: that email's counters start over, at both doors. */
export async function clearSigninCounters(email: string): Promise<void> {
  const normalised = email.trim().toLowerCase()
  const { account, accountDay } = signinKeys(normalised, undefined)
  await Promise.all([forget(account), forget(accountDay), forget(storedMobileAccountKey(normalised))])
}
