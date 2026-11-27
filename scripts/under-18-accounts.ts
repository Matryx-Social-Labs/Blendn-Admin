import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"

import { ACCOUNT_MIN_AGE, ageFrom, dateOfBirthRefusal, isKnownMinor, parseDateOfBirth } from "../lib/age"
import { auditInTx } from "../lib/audit-log"
import { isStaffEmail } from "../lib/company"

/**
 * Accounts known to be under 18 (SCRUM-1169, D-026).
 *
 *   npx tsx scripts/under-18-accounts.ts                     dry run: counts and ids
 *   npx tsx scripts/under-18-accounts.ts --apply             stamp, then list the ones due
 *   npx tsx scripts/under-18-accounts.ts --correct <userId> <YYYY-MM-DD> --by <staff address>
 *
 * A known age under 18 takes part nowhere (`participationDenial`, lib/age.ts).
 * `--apply` stamps `profiles.under_18_since = now()` on every live account with
 * a known age under 18 and no stamp, once: a stamp is never moved. It then
 * lists the accounts stamped `DELETE_AFTER_DAYS` or more days ago as due for
 * deletion. The 14 days are for a birth date entered wrong (D-026).
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
  "usage: under-18-accounts.ts [--apply | --correct <userId> <YYYY-MM-DD> --by <staff address>] [--environment <staging|production>]"

type Env = Record<string, string | undefined>
type Mode = { mode: "dry-run" } | { mode: "apply" } | { mode: "correct"; userId: string; dateOfBirth: string; by: string }
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
  if (rest.length === 1 && rest[0] === "--apply") return { mode: "apply", ...env }
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

/** Live accounts with a known age under 18 and no stamp, by id. */
export async function knownMinorsUnstamped(db: PrismaClient, now: Date): Promise<string[]> {
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
    select: { id: true, age: true, date_of_birth: true, under_18_since: true },
    orderBy: { id: "asc" },
  })
  return rows.filter((row) => isKnownMinor(row)).map((row) => row.id)
}

/** Stamp every live, unstamped account with a known age under 18. A stamp already set is never moved. */
export async function stampKnownMinors(db: PrismaClient, now: Date): Promise<string[]> {
  const ids = await knownMinorsUnstamped(db, now)
  if (ids.length > 0) await db.profiles.updateMany({ where: { id: { in: ids }, under_18_since: null }, data: { under_18_since: now } })
  return ids
}

/** Live accounts stamped `DELETE_AFTER_DAYS` or more days before `now`, oldest stamp first. */
export async function dueForDeletion(db: PrismaClient, now: Date): Promise<string[]> {
  const rows = await db.profiles.findMany({
    where: { under_18_since: { lte: new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS) }, user: { deletedAt: null } },
    select: { id: true },
    orderBy: [{ under_18_since: "asc" }, { id: "asc" }],
  })
  return rows.map((row) => row.id)
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

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  const now = new Date()
  try {
    console.log(`database: ${command.environment ?? "local"} (${new URL(process.env.DATABASE_URL ?? "").hostname})  mode: ${command.mode}`)
    if (command.mode === "correct") {
      await correctBirthDate(db, { ...command }, now)
      console.log(`corrected: ${command.userId} (birth date set, stamp cleared, audit row written)`)
      return
    }
    if (command.mode === "apply") {
      printIds("stamped now (known age under 18)", await stampKnownMinors(db, now))
    } else {
      printIds("would stamp (known age under 18, no stamp)", await knownMinorsUnstamped(db, now))
    }
    printIds(`due for deletion (stamped ${DELETE_AFTER_DAYS}+ days ago)`, await dueForDeletion(db, now))
    if (command.mode === "dry-run") console.log("\nDry run: nothing written. Re-run with --apply to stamp.")
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
