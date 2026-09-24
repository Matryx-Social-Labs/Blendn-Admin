import { PrismaClient, type organisations, type user_role } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { checkPassword } from "../lib/password"

/**
 * The four accounts people sign in as to look at the dashboard.
 *
 *   admin@blendn.app  organizer@blendn.app  venue.owner@blendn.app  sponsor@blendn.app
 *
 * One per role, all with one password: `SEED_PASSWORD` on Railway staging.
 *
 * ## Written on every staging deploy
 *
 * `railway.json`'s pre-deploy step runs this after the migrations. It runs
 * inside Railway's network, so it never meets the internal hostname that
 * `railway run` hands a laptop, and changing the variable is the whole of a
 * password rotation — Railway redeploys and this re-asserts it.
 *
 * Before this, the password existed only on the command line of whoever last
 * ran `seed-qa`. On 2026-09-22 a run without it gave every account a random
 * one, and testers were locked out for ~27 hours before anyone noticed.
 *
 * Each run also puts back whatever a tester broke: the role, a suspension, a
 * deletion, the organisation membership. A role is not access — see the
 * header of `seed-qa.ts` — so an organiser without the membership signs in to
 * an empty dashboard that looks exactly like a bug.
 *
 * ## Never on production
 *
 * `skipReason` refuses there even with the variable set. A shared-password
 * app_admin on production reads every real user's data.
 *
 * ## The personas were renamed, not recreated
 *
 * These are the people `seed-qa` has always seeded, under role addresses
 * instead of their own. `formerly` renames the row in place, so the id — and
 * every event, venue, claim and audit row pointing at it — stays where it was.
 */

type AccountKey = "admin" | "organiser" | "venue" | "sponsor"
type OrgKey = "events" | "venues" | "brands"

export interface TestAccount {
  key: AccountKey
  email: string
  /** The persona's address before it moved to a role address. */
  formerly: string
  name: string
  role: user_role
  org: OrgKey | null
  note: string
}

export const TEST_ACCOUNTS: readonly TestAccount[] = [
  {
    key: "admin",
    email: "admin@blendn.app",
    formerly: "priya.menon@blendn.app",
    name: "Priya Menon",
    role: "app_admin",
    org: null,
    note: "Sees everything. eventPermissions short-circuits before org checks.",
  },
  {
    key: "organiser",
    email: "organizer@blendn.app",
    formerly: "arjun.rao@blendn.app",
    name: "Arjun Rao",
    role: "organizer",
    org: "events",
    note: "Member of the org that RUNS the events. May edit and operate them.",
  },
  {
    key: "venue",
    email: "venue.owner@blendn.app",
    formerly: "fatima.sheikh@blendn.app",
    name: "Fatima Sheikh",
    role: "venue_owner",
    org: "venues",
    note: "Member of the org that OWNS the buildings. May operate, must NOT edit.",
  },
  {
    key: "sponsor",
    email: "sponsor@blendn.app",
    formerly: "meera.iyer@blendn.app",
    name: "Meera Iyer",
    role: "sponsor",
    org: "brands",
    note: "Member of the org that BUYS placements. Brand, placements, charges.",
  },
]

export const TEST_ORG_NAMES: Record<OrgKey, string> = {
  events: "Nightshift Collective",
  venues: "Indiranagar Hospitality Group",
  brands: "Blue Tokai Coffee Roasters",
}

/**
 * Test accounts from earlier seeds that the role accounts replace. Suspended,
 * not deleted — deleting a user cascades through other people's history — and
 * any live event they still own moves to the organiser.
 *
 * Disposable, like `RETIRED_SLUGS` in `seed-qa.ts`: once no environment has
 * these rows, the list can go.
 */
export const RETIRED_TEST_ACCOUNTS: readonly string[] = [
  "qa-admin@blendn.app",
  "qa-organiser@blendn.app",
  "qa-venue@blendn.app",
  "qa-outsider@blendn.app",
  "john@test.com",
  "jane@test.com",
  "mike@test.com",
  "sarah@test.com",
  "alex@test.com",
  "roomseed-organiser@blendn.invalid",
]

export interface TestAccountsWorld {
  accounts: readonly TestAccount[]
  orgNames: Record<OrgKey, string>
  retired: readonly string[]
}

const WORLD: TestAccountsWorld = {
  accounts: TEST_ACCOUNTS,
  orgNames: TEST_ORG_NAMES,
  retired: RETIRED_TEST_ACCOUNTS,
}

/** Same cost as `create-dashboard-user.ts` and `seed-qa.ts`. */
const HASH_COST = 12

/** Why the pre-deploy step should write nothing, or null to go ahead. */
export function skipReason(env: Record<string, string | undefined>): string | null {
  if (env.RAILWAY_ENVIRONMENT_NAME === "production") {
    return "production — test accounts are staging-only"
  }
  if (!env.SEED_PASSWORD?.trim()) return "SEED_PASSWORD is not set"
  return null
}

/**
 * Create or repair the role accounts. Idempotent; the password is rehashed
 * only when it changed.
 *
 * Throws on a password the product's own rule would refuse, before writing
 * anything. On Railway that fails the deploy, which is louder and better than
 * an account nobody can sign in to.
 */
export async function ensureTestAccounts(
  db: PrismaClient,
  password: string,
  world: TestAccountsWorld = WORLD
): Promise<{ users: Record<AccountKey, string>; orgs: Record<OrgKey, organisations> }> {
  for (const account of world.accounts) {
    const check = checkPassword(password, account.email)
    if (!check.ok) throw new Error(`SEED_PASSWORD refused for ${account.email}: ${check.message}`)
  }

  const orgs = {
    events: await upsertOrg(db, world.orgNames.events),
    venues: await upsertOrg(db, world.orgNames.venues),
    brands: await upsertOrg(db, world.orgNames.brands),
  }

  const users = {} as Record<AccountKey, string>
  for (const account of world.accounts) {
    await renameFormer(db, account)
    users[account.key] = await upsertAccount(db, account, password)

    await db.profiles.upsert({
      where: { id: users[account.key] },
      update: {},
      /*
       * An age, because the mobile side needs one and age gating cannot be
       * tested without a viewer whose age is known. 30 clears every `min_age`
       * the seed uses.
       */
      create: { id: users[account.key], name: account.name, age: 30 },
    })

    if (account.org) {
      const orgId = orgs[account.org].id
      await db.organisation_members.upsert({
        where: { org_id_user_id: { org_id: orgId, user_id: users[account.key] } },
        update: { role: "owner" },
        create: { org_id: orgId, user_id: users[account.key], role: "owner", is_primary_contact: true },
      })
    }
  }

  await retire(db, world.retired, users.organiser, orgs.events.id)

  return { users, orgs }
}

async function renameFormer(db: PrismaClient, account: TestAccount) {
  const [former, current] = await Promise.all([
    db.user.findUnique({ where: { email: account.formerly }, select: { id: true } }),
    db.user.findUnique({ where: { email: account.email }, select: { id: true } }),
  ])
  if (!former) return
  if (current) {
    console.log(`  !  ${account.formerly} and ${account.email} both exist — left both alone`)
    return
  }
  await db.user.update({ where: { id: former.id }, data: { email: account.email } })
  console.log(`  renamed ${account.formerly} → ${account.email}`)
}

async function upsertAccount(db: PrismaClient, account: TestAccount, password: string) {
  const existing = await db.user.findUnique({
    where: { email: account.email },
    select: { id: true, password: true, emailVerified: true },
  })

  /*
   * Verified, or `linkVerifiedOAuthIdentity` treats the password account as a
   * squatter: a Google sign-in with the same address takes it over and nulls
   * the password. See `seed-review-account.ts`.
   */
  if (!existing) {
    const created = await db.user.create({
      data: {
        email: account.email,
        name: account.name,
        password: await bcrypt.hash(password, HASH_COST),
        role: account.role,
        emailVerified: new Date(),
      },
      select: { id: true },
    })
    return created.id
  }

  const unchanged = existing.password ? await bcrypt.compare(password, existing.password) : false
  await db.user.update({
    where: { id: existing.id },
    data: {
      role: account.role,
      deletedAt: null,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
      ...(!unchanged && { password: await bcrypt.hash(password, HASH_COST) }),
      ...(!existing.emailVerified && { emailVerified: new Date() }),
    },
  })
  return existing.id
}

async function retire(db: PrismaClient, emails: readonly string[], organiserId: string, orgId: string) {
  const retired = await db.user.findMany({ where: { email: { in: [...emails] } }, select: { id: true } })
  if (retired.length === 0) return
  const ids = retired.map((u) => u.id)

  const suspended = await db.user.updateMany({
    where: { id: { in: ids }, suspended_at: null },
    data: {
      suspended_at: new Date(),
      suspension_reason: "Retired test account, replaced by the role accounts in scripts/test-accounts.ts",
    },
  })
  const adopted = await db.events.updateMany({
    where: { organizer_id: { in: ids }, deleted_at: null },
    data: { organizer_id: organiserId, organizer_org_id: orgId, updated_at: new Date() },
  })
  if (suspended.count || adopted.count) {
    console.log(`  retired ${suspended.count} old test account(s), moved ${adopted.count} live event(s) to the organiser`)
  }
}

/**
 * Created verified; an existing one is left as it is. Flipping a suspended org
 * back to verified here would leave its events in the drafts the suspension
 * parked them in — `setOrganisationStatus` is the path that restores both.
 */
async function upsertOrg(db: PrismaClient, displayName: string) {
  const existing = await db.organisations.findFirst({ where: { display_name: displayName } })
  if (existing) return existing
  return db.organisations.create({
    data: { display_name: displayName, kind: "company", status: "verified", verified_at: new Date() },
  })
}

/* -------------------------------------------------------------------------- */

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host
    } catch {
      return "(unparseable DATABASE_URL)"
    }
  })()
  console.log(`test accounts → ${host} (${process.env.RAILWAY_ENVIRONMENT_NAME ?? "no Railway environment"})`)

  const skip = skipReason(process.env)
  if (skip) {
    console.log(`  skipped: ${skip}`)
    return
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    await ensureTestAccounts(db, process.env.SEED_PASSWORD?.trim() ?? "")
    // The addresses, never the password: this prints into Railway's deploy log.
    for (const a of TEST_ACCOUNTS) console.log(`  ${a.role.padEnd(12)} ${a.email}`)
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
