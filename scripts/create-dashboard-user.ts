/**
 * Create or reset a dashboard login.
 *
 *   DATABASE_URL=... npx tsx scripts/create-dashboard-user.ts <email> [role]
 *   DATABASE_URL=... npx tsx scripts/create-dashboard-user.ts qa@blendn.app app_admin
 *
 * role defaults to app_admin; organizer and venue_owner are also accepted.
 * attendee is refused — attendees are mobile-only and middleware.ts bounces
 * them off /dashboard, so creating one here would produce an account that
 * cannot sign in to the thing this script exists to grant access to.
 *
 * The password is generated, never taken as an argument: a password passed on
 * the command line lands in shell history and in the process list. It is
 * printed once, on stdout, and not stored anywhere else.
 *
 * Existing users are updated in place rather than duplicated, so this doubles
 * as a password reset.
 */
import { randomBytes } from "crypto"
import { PrismaClient, type user_role } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"

const DASHBOARD_ROLES = ["app_admin", "organizer", "venue_owner"] as const

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

/**
 * 24 bytes of CSPRNG entropy in base64url — ~143 bits, well past anything
 * worth brute forcing, and safe to paste into a browser without escaping.
 */
function generatePassword() {
  return randomBytes(24).toString("base64url")
}

async function main() {
  const [email, role = "app_admin"] = process.argv.slice(2)

  if (!email || !email.includes("@")) {
    console.error("usage: create-dashboard-user.ts <email> [app_admin|organizer|venue_owner]")
    process.exit(1)
  }

  if (!DASHBOARD_ROLES.includes(role as (typeof DASHBOARD_ROLES)[number])) {
    console.error(`role must be one of: ${DASHBOARD_ROLES.join(", ")} (got "${role}")`)
    process.exit(1)
  }

  const password = generatePassword()
  // Cost 12 to match prisma/seed.ts and lib/mobile-auth.ts. Mismatched cost
  // factors still verify correctly but make the hash's origin ambiguous.
  const hashed = await bcrypt.hash(password, 12)

  const existing = await db.user.findUnique({ where: { email } })

  const user = await db.user.upsert({
    where: { email },
    update: { password: hashed, role: role as user_role, deletedAt: null },
    create: {
      email,
      name: email.split("@")[0],
      password: hashed,
      role: role as user_role,
      emailVerified: new Date(),
    },
  })

  console.log(`\n${existing ? "Reset password for existing" : "Created"} user\n`)
  console.log(`  email     ${user.email}`)
  console.log(`  password  ${password}`)
  console.log(`  role      ${user.role}`)
  console.log(`  id        ${user.id}\n`)
  console.log("Shown once. Not recoverable from the database — rerun this to reset it.\n")
}

main()
  .catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
  .finally(() => db.$disconnect())
