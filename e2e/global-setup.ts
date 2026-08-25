import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { chromium, type FullConfig } from "@playwright/test"
import { encode } from "next-auth/jwt"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { ROLE_ACCOUNTS, type RoleKey } from "./fixtures/auth"

/**
 * Establish one session per role, for the whole run.
 *
 * ## Why this mints the cookie instead of posting to the sign-in endpoint
 *
 * `middleware.ts` rate-limits `POST /api/auth/callback/credentials` to **5 per
 * IP per 15 minutes** (`DASHBOARD_SIGNIN`). The suite covers **six** roles, so
 * a harness that signs in — even once per role, even once per run — cannot
 * pass. The sixth attempt returns 429, and because a rejected credential and a
 * throttled request both leave the session empty, it presents as "wrong
 * password". That cost an hour of checking bcrypt hashes that were correct.
 *
 * Raising the limit for tests was the wrong fix: it exists because NextAuth has
 * no built-in throttling and this is a credential endpoint. The suite should
 * fit the product.
 *
 * So the session is minted with `next-auth/jwt`'s own `encode`, using the
 * application's `NEXTAUTH_SECRET` — the same function, the same secret, the
 * same cookie NextAuth would have set. Nothing about the session is faked; only
 * the *typing of a password* is skipped.
 *
 * **Sign-in itself is still covered**, by `sign-in.spec.ts`, which drives the
 * real form once. That is the right place for it: one spec proves the door
 * works, and the other thirty do not each queue up at it.
 */
export const AUTH_DIR = join(__dirname, ".auth")

export function statePathFor(role: RoleKey) {
  return join(AUTH_DIR, `${role}.json`)
}

export default async function globalSetup(config: FullConfig) {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env.E2E_BASE_URL ?? "http://localhost:3000"

  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required — it is what signs the session cookie.")
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required — the seeded users are looked up by email.")
  }

  mkdirSync(AUTH_DIR, { recursive: true })

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  const { hostname, protocol } = new URL(baseURL)
  // NextAuth prefixes the cookie with `__Secure-` over https, and the name has
  // to match or the server never sees the session.
  const cookieName =
    protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token"

  const browser = await chromium.launch()
  try {
    for (const role of Object.keys(ROLE_ACCOUNTS) as RoleKey[]) {
      const { email, role: expected } = ROLE_ACCOUNTS[role]
      const user = await db.user.findUnique({
        where: { email },
        select: { id: true, role: true },
      })

      if (!user) {
        throw new Error(
          `No seeded user for ${role} (${email}). Run: SEED_PASSWORD=... npm run seed:qa -- --apply`
        )
      }
      if (user.role !== expected) {
        throw new Error(`${email} has role ${user.role}, expected ${expected}.`)
      }

      /*
       * `sub` is the whole payload that matters. `lib/auth.ts`'s jwt callback
       * re-reads the role from the database on every request precisely so a
       * stale claim cannot outlive a demotion — so seeding a role here would be
       * ignored, which is the correct behaviour and worth knowing.
       */
      const token = await encode({
        // `role` is in the JWT type, so it has to be present; the value is
        // irrelevant because the jwt callback overwrites it from the database
        // on the very next request. Seeding the real one keeps the cookie
        // honest rather than merely type-correct.
        token: { sub: user.id, role: user.role },
        secret,
        maxAge: 30 * 24 * 60 * 60,
      })

      const context = await browser.newContext({ baseURL })
      await context.addCookies([
        {
          name: cookieName,
          value: token,
          domain: hostname,
          path: "/",
          httpOnly: true,
          secure: protocol === "https:",
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ])

      // Prove the server accepts it, here, once — rather than discovering a
      // malformed cookie as thirty confusing redirects later.
      const page = await context.newPage()
      // A relative fetch needs a same-origin document; `about:blank` has none.
      await page.goto("/login")
      const session = await page.evaluate(
        async () => (await (await fetch("/api/auth/session")).json()) as { user?: { role?: string } }
      )
      if (session.user?.role !== expected) {
        throw new Error(
          `Minted session for ${role} was not accepted. Expected role ${expected}, got ` +
            `${JSON.stringify(session)}. Does NEXTAUTH_SECRET match the running server's?`
        )
      }

      await context.storageState({ path: statePathFor(role) })
      await context.close()
    }
  } finally {
    await browser.close()
    await db.$disconnect()
  }
}
