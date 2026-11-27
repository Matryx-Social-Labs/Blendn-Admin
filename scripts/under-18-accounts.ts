import { PrismaClient } from "@prisma/client"

import { eraseAccount } from "../lib/account-erasure"
import { ACCOUNT_MIN_AGE, ageFrom, dateOfBirthRefusal, isKnownMinor, parseDateOfBirth } from "../lib/age"
import { auditInTx } from "../lib/audit-log"
import { performCheckout } from "../lib/checkout"
import { isStaffEmail } from "../lib/company"
import { closeDb, db as appDb } from "../lib/db"

/**
 * Accounts known to be under 18 (SCRUM-1169, D-026).
 *
 *   npx tsx scripts/under-18-accounts.ts                     dry run: counts and ids
 *   npx tsx scripts/under-18-accounts.ts --apply --limit <n> stamp, end their check-ins, then erase the ones due
 *   npx tsx scripts/under-18-accounts.ts --correct <userId> <YYYY-MM-DD> --by <staff address>
 *
 * A known age under 18 takes part nowhere (`participationDenial`, lib/age.ts).
 * `--apply` stamps `profiles.under_18_since = now()` on every live account with
 * a known age under 18 and no stamp, once: a stamp is never moved. A stamp
 * locks the account (`accountBlockReason`, lib/mobile-auth.ts). An account
 * with a staff role or an organisation membership is never stamped: it is
 * listed apart, for a person to look at. `--apply` then ends every stamped
 * account's open check-ins through `performCheckout`, and
 * erases each account stamped `DELETE_AFTER_DAYS` or more days ago through
 * `eraseAccount` (lib/account-erasure.ts), the erasure the account deletion
 * runs, one at a time, and stops at the first failure, naming the id. The
 * 14 days are for a birth date entered wrong (D-026). The dry run lists them.
 *
 * `--limit <n>` is required with `--apply`: a run that would stamp or erase
 * more than n accounts is refused before it writes anything.
 *
 * In this process `eraseAccount`'s in-memory steps (the token blocklist and
 * socket eviction) reach only this process. The server reads `deletedAt` and
 * the stamp at its next blocklist refresh, which closes the account's open
 * sockets, and at its socket handshake. The Apple revoke has no code from the
 * app here, so it logs and audits "not revoked", as the route does without one.
 *
 * `--correct` is the answer to a person who writes to the grievance address
 * that their birth date is wrong: it sets the birth date (18 or over, a real
 * date), the age that goes with it, and clears the stamp, in one transaction
 * with an audit row whose actor is the `app_admin` named by `--by`, carrying
 * when the account was stamped and never the date.
 *
 * Output is counts and user ids only: no name, email, phone or birth date.
 *
 * RUNBOOK
 * - A local database: no flags beyond the mode.
 * - Staging or production: through `railway run -e <staging|production>`, with
 *   the database's public URL as DATABASE_URL for that one command, and
 *   `--environment <the same name>`. Anything else is refused before a query.
 * - Record each run (date, mode, counts, never the ids) on SCRUM-1169.
 */

export const DELETE_AFTER_DAYS = 14
const DAY_MS = 86_400_000
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const ENVIRONMENTS = new Set(["staging", "production"])
const USAGE =
  "usage: under-18-accounts.ts [--apply --limit <n> | --correct <userId> <YYYY-MM-DD> --by <staff address>] [--environment <staging|production>]"

type Env = Record<string, string | undefined>
type Mode = { mode: "dry-run" } | { mode: "apply"; limit: number } | { mode: "correct"; userId: string; dateOfBirth: string; by: string }
export type Command = Mode & { environment?: string }

/** The command, or why it is refused. */
export function parseArgs(args: string[]): Command | string {
  const rest = [...args]
  let environment: string | undefined
  const at = rest.indexOf("--environment")
  if (at !== -1) {
    environment = rest[at + 1]
    if (!environment || environment.startsWith("--")) return USAGE
    rest.splice(at, 2)
  }
  const env = environment ? { environment } : {}

  if (rest.length === 0) return { mode: "dry-run", ...env }
  if (rest[0] === "--apply" && rest.length <= 3) {
    const limit = rest[1] === "--limit" && /^\d+$/.test(rest[2] ?? "") ? Number(rest[2]) : null
    if (limit === null || rest.length !== 3) return "--apply needs --limit <n>: the most accounts this run may stamp or erase"
    return { mode: "apply", limit, ...env }
  }
  if (rest[0] !== "--correct" || rest.length !== 5 || rest[3] !== "--by") return USAGE
  const [, userId, dateOfBirth, , by] = rest
  if (!isStaffEmail(by)) return "--by must be the staff address making the correction (on the company domain)"
  return { mode: "correct", userId, dateOfBirth, by, ...env }
}

/**
 * Why this run must not go ahead, or null. A local database with no Railway
 * environment; or staging or production named by `railway run` and by
 * `--environment` alike. pg lets `?host=` override the URL's host, so every
 * host named must be local.
 */
export function environmentRefusal(env: Env, environment: string | undefined): string | null {
  let hosts: string[]
  try {
    const url = new URL(env.DATABASE_URL ?? "")
    hosts = [url.hostname, ...url.searchParams.getAll("host")]
  } catch {
    return "DATABASE_URL is not set or not a URL"
  }
  const railway = env.RAILWAY_ENVIRONMENT_NAME
  if (!railway && !environment && hosts.every((h) => LOCAL_HOSTS.has(h))) return null
  if (railway && environment === railway && ENVIRONMENTS.has(railway)) return null
  const where = railway ? `Railway environment "${railway}"` : hosts.find((h) => !LOCAL_HOSTS.has(h)) || "(no host)"
  return `${where} is not a local database. Run it through railway run -e <staging|production> with --environment <the same name>.`
}

/** Live accounts with a known age under 18 and no stamp, by id; staff are `staffKnownMinors`. */
export async function knownMinorsUnstamped(db: PrismaClient, now: Date): Promise<string[]> {
  return (await unstampedMinors(db, now)).filter((row) => !row.staff).map((row) => row.id)
}

/** The same, for accounts with a staff role or an organisation membership: never stamped, listed for a person. */
export async function staffKnownMinors(db: PrismaClient, now: Date): Promise<string[]> {
  return (await unstampedMinors(db, now)).filter((row) => row.staff).map((row) => row.id)
}

async function unstampedMinors(db: PrismaClient, now: Date): Promise<{ id: string; staff: boolean }[]> {
  // A superset in SQL (a stored age under 18, or a birth date after the cut-off); `isKnownMinor` decides, as the routes do.
  // A day early, so 29 February's roll-over to 1 March cannot leave a birthday out.
  const cutoff = new Date(now)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - ACCOUNT_MIN_AGE)
  cutoff.setUTCDate(cutoff.getUTCDate() - 1)
  const rows = await db.profiles.findMany({
    where: {
      under_18_since: null,
      user: { deletedAt: null },
      OR: [{ age: { lt: ACCOUNT_MIN_AGE } }, { date_of_birth: { gt: cutoff } }],
    },
    select: {
      id: true,
      age: true,
      date_of_birth: true,
      under_18_since: true,
      user: { select: { role: true, _count: { select: { org_memberships: true } } } },
    },
    orderBy: { id: "asc" },
  })
  return rows
    .filter((row) => isKnownMinor(row))
    .map((row) => ({ id: row.id, staff: row.user.role !== "attendee" || row.user._count.org_memberships > 0 }))
}

/** Stamp every live, unstamped account with a known age under 18. A stamp already set is never moved. */
export async function stampKnownMinors(db: PrismaClient, now: Date): Promise<string[]> {
  const ids = await knownMinorsUnstamped(db, now)
  if (ids.length > 0) await db.profiles.updateMany({ where: { id: { in: ids }, under_18_since: null }, data: { under_18_since: now } })
  return ids
}

/** End every open check-in of a live stamped account, the way a check-out does; the ids of the accounts checked out. */
export async function endStampedCheckIns(db: PrismaClient, now: Date): Promise<string[]> {
  const open = await db.event_check_ins.findMany({
    where: { status: "checked_in", user: { deletedAt: null, profile: { is: { under_18_since: { not: null } } } } },
    select: { id: true },
  })
  const ids: string[] = []
  for (const { id } of open) {
    const result = await performCheckout(id, "manual", now)
    if (result?.changed) ids.push(result.userId)
  }
  return ids
}

/**
 * `--apply`: stamp, end the stamped accounts' check-ins, erase the ones due.
 * Refused, before anything is written, when it would stamp or erase more than
 * `limit` accounts.
 */
export async function applyRun(db: PrismaClient, now: Date, limit: number, erase: typeof eraseAccount = eraseAccount) {
  const [toStamp, due, notStamped] = await Promise.all([
    knownMinorsUnstamped(db, now),
    dueForDeletion(db, now),
    staffKnownMinors(db, now),
  ])
  if (toStamp.length > limit || due.length > limit) {
    throw new Error(`REFUSING: would stamp ${toStamp.length} and erase ${due.length}, over --limit ${limit}. Nothing written.`)
  }
  const stamped = await stampKnownMinors(db, now)
  const checkedOut = await endStampedCheckIns(db, now)
  const { erased, skipped } = await deleteDue(db, now, erase)
  return { stamped, notStamped, checkedOut, erased, skipped }
}

const dueWhere = (now: Date) => ({
  under_18_since: { lte: new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS) },
  user: { deletedAt: null },
})

/** Live accounts stamped `DELETE_AFTER_DAYS` or more days before `now`, oldest stamp first. */
export async function dueForDeletion(db: PrismaClient, now: Date): Promise<string[]> {
  const rows = await db.profiles.findMany({
    where: dueWhere(now),
    select: { id: true },
    orderBy: [{ under_18_since: "asc" }, { id: "asc" }],
  })
  return rows.map((row) => row.id)
}

/**
 * Erase every account due, oldest stamp first, one at a time, each one's
 * deferred work awaited before the next. Each id is read again just before its
 * erasure, so one a staff correction cleared since the list was read is
 * skipped (and listed). Stops at the first failure, or at the first account
 * with a part not erased (storage, RevenueCat), naming the id, the ids erased
 * before it, and whether its account row is erased: a row not erased is due
 * again; the parts of an erased one are not retried by a later run.
 * `erase` is `eraseAccount`; a test passes its own.
 */
export async function deleteDue(
  db: PrismaClient,
  now: Date,
  erase: typeof eraseAccount = eraseAccount
): Promise<{ erased: string[]; skipped: string[] }> {
  const erased: string[] = []
  const skipped: string[] = []
  for (const id of await dueForDeletion(db, now)) {
    if ((await db.profiles.count({ where: { id, ...dueWhere(now) } })) === 0) {
      skipped.push(id)
      continue
    }
    const deferred: Promise<void>[] = []
    let failure: string | null = null
    try {
      const notErased = await erase(id, { ipAddress: "script", defer: (task) => void deferred.push(task()) })
      await Promise.all(deferred)
      if (notErased.length > 0) failure = `not erased: ${notErased.join(", ")}`
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure) {
      const row = await db.user.findUnique({ where: { id }, select: { deletedAt: true } })
      const state = row?.deletedAt ? "the account row is erased" : "the account row is not erased, a run after retries it"
      throw new Error(`Erasing ${id} failed (erased before it: ${erased.join(", ") || "none"}; ${state}): ${failure}`)
    }
    erased.push(id)
  }
  return { erased, skipped }
}

/** Set a corrected birth date, clear the stamp, and record who did it. Throws, changing nothing, on a refused date, account or actor. */
export async function correctBirthDate(
  db: PrismaClient,
  { userId, dateOfBirth, by, environment }: { userId: string; dateOfBirth: string; by: string; environment?: string },
  now: Date
): Promise<void> {
  const refusal = dateOfBirthRefusal(dateOfBirth, now)
  const dob = parseDateOfBirth(dateOfBirth, now)
  if (refusal || !dob) throw new Error(refusal ?? "Enter a real date of birth in YYYY-MM-DD form.")
  await db.$transaction(async (tx) => {
    const admin = await tx.user.findFirst({
      where: { email: by.trim().toLowerCase(), role: "app_admin", deletedAt: null, suspended_at: null },
      select: { id: true },
    })
    if (!admin) throw new Error("--by must be the address of a live app_admin")
    const row = await tx.profiles.findFirst({
      where: { id: userId, user: { deletedAt: null } },
      select: { under_18_since: true },
    })
    if (!row) throw new Error("No live account with that id")
    await tx.profiles.update({
      where: { id: userId },
      data: { date_of_birth: dob, age: ageFrom({ date_of_birth: dob }, now), under_18_since: null },
    })
    await auditInTx(tx, {
      userId: admin.id,
      action: "profile.under_18_corrected",
      resource: "user",
      resourceId: userId,
      orgId: null,
      details: { stampedAt: row.under_18_since?.toISOString() ?? null, environment: environment ?? "local" },
    })
  })
}

function printIds(title: string, ids: string[]) {
  console.log(`${title}: ${ids.length}`)
  for (const id of ids) console.log(`  ${id}`)
}

async function main() {
  const command = parseArgs(process.argv.slice(2))
  if (typeof command === "string") throw new Error(command)
  const refused = environmentRefusal(process.env, command.environment)
  if (refused) throw new Error(`REFUSING: ${refused}`)

  // The client `eraseAccount` writes through, so the whole run uses one pool.
  const db = appDb
  const now = new Date()
  try {
    console.log(`database: ${command.environment ?? "local"} (${new URL(process.env.DATABASE_URL ?? "").hostname})  mode: ${command.mode}`)
    if (command.mode === "correct") {
      await correctBirthDate(db, { ...command }, now)
      console.log(`corrected: ${command.userId} (birth date set, stamp cleared, audit row written)`)
      return
    }
    if (command.mode === "apply") {
      const run = await applyRun(db, now, command.limit)
      printIds("stamped now (known age under 18)", run.stamped)
      printIds("not stamped (staff role or organisation member: for a person to look at)", run.notStamped)
      printIds("checked out (stamped, still checked in)", run.checkedOut)
      printIds(`erased (stamped ${DELETE_AFTER_DAYS}+ days ago)`, run.erased)
      printIds("skipped (no longer due when its turn came)", run.skipped)
      return
    }
    printIds("would stamp (known age under 18, no stamp)", await knownMinorsUnstamped(db, now))
    printIds("would not stamp (staff role or organisation member)", await staffKnownMinors(db, now))
    printIds(`would erase (stamped ${DELETE_AFTER_DAYS}+ days ago)`, await dueForDeletion(db, now))
    console.log("\nDry run: nothing written. Re-run with --apply --limit <n> to stamp and erase.")
  } finally {
    await closeDb()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
