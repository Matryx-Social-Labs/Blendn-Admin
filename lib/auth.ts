import { PrismaAdapter } from "@auth/prisma-adapter"
import { NextAuthOptions, getServerSession, User } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { db } from "./db"
import { cookies } from "next/headers"
import { DUMMY_HASH, MAX_EMAIL_LENGTH, refuseOverSigninLimits, settleSigninSuccess, signinKeys } from "./dashboard-signin-limits"
import { KNOWN_DEVICE_MAX_AGE_SECONDS, isKnownDevice, knownDeviceCookie } from "./known-device"
import { logger } from "./logger"
import { APP_ONLY_SIGNIN, canAccessDashboard } from "./rbac"
import { SessionEnded, isRevoked, provenAt } from "./session-revocation"
import type { user_role } from "@prisma/client"

/** Sets the known-device cookie on this response (a route handler's `cookies()` is merged into it). */
async function rememberDevice(email: string): Promise<void> {
  const cookie = knownDeviceCookie(email)
  if (!cookie) return
  try {
    ;(await cookies()).set(cookie.name, cookie.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: KNOWN_DEVICE_MAX_AGE_SECONDS,
    })
  } catch (error) {
    // Outside a request there is nothing to set it on; the sign-in itself stands.
    logger.warn("Could not set the known-device cookie", { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * An attendee an organisation invited may sign in, or the invite could never be accepted: `/invite` needs a session and
 * accepting it is what moves them out of `attendee`. Their session opens nothing else: the middleware and `lib/rbac.ts`
 * still read the role.
 *
 * ponytail: one who signs in at /login rather than through the link lands back on the form; the mail is the way in.
 */
async function hasLiveInvite(email: string): Promise<boolean> {
  const invite = await db.organisation_invites.findFirst({
    where: {
      // Exact, both sides lowercase: `mode: "insensitive"` is ILIKE, where `_` in a sign-up address matches any character.
      email: email.trim().toLowerCase(),
      accepted_at: null,
      revoked_at: null,
      expires_at: { gt: new Date() },
      org: { status: { not: "suspended" } },
    },
    select: { id: true },
  })
  return Boolean(invite)
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        // Stored lowercase (SCRUM-328), so the lookup is too.
        const email = credentials.email.trim().toLowerCase()
        // Before it becomes a limiter key.
        if (email.length > MAX_EMAIL_LENGTH) return null
        const keys = signinKeys(email, req?.headers)
        const knownDevice = isKnownDevice(email, req?.headers?.cookie)
        await refuseOverSigninLimits(keys, knownDevice)
        const user = await db.user.findUnique({ where: { email } })

        const isValid = await bcrypt.compare(credentials.password, user?.password ?? DUMMY_HASH)
        if (!user?.password || !isValid) {
          return null
        }
        await settleSigninSuccess(keys, knownDevice)
        await rememberDevice(email)

        /*
         * A suspended or deleted account cannot sign in.
         *
         * This read the password and nothing else, so suspension -- the one
         * action a moderator takes to stop somebody -- did not stop them
         * signing into the dashboard. The mobile side has checked
         * `accountBlockReason` since it shipped; this path never did.
         *
         * Returning null, not a specific error: which of the two it is, is not
         * information a failed sign-in should disclose.
         */
        if (user.deletedAt || user.suspended_at) {
          return null
        }

        /*
         * An attendee is refused here, by name, rather than let through.
         *
         * Returning them minted a dashboard cookie the middleware then refused
         * on every page, so the form reappeared with nothing on it and they
         * typed a right password until the sign-in limit said "too many
         * attempts" (SCRUM-172). Naming the role is safe only after the
         * password check above; a wrong password never reaches this line.
         */
        if (!canAccessDashboard(user.role) && !(await hasLiveInvite(user.email))) {
          throw new Error(APP_ONLY_SIGNIN)
        }

        return { id: user.id, email: user.email, name: user.name, role: user.role }
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (!token || !session.user) return session
      return { ...session, user: { ...session.user, id: token.sub!, role: token.role, signedInAt: token.signedInAt } }
    },
    /*
     * Every read of a session answers to the database, and ends it when
     * `isRevoked` says so (lib/session-revocation.ts).
     *
     * With the JWT strategy there is no session table to clear, and the
     * default session is 30 days. This callback used to write `role` only at
     * sign-in, so a demoted admin kept `app_admin` in a live cookie for a
     * month; it was made to re-read the role. Suspension and deletion were the
     * next: blocking `authorize()` stops only the next sign-in, and the
     * suspend transaction's `session.deleteMany()` had no rows to delete.
     * Then the password (step 18 security review, M6): a reset is how the
     * owner locks out whoever holds their session.
     *
     * The first version of that demoted an ended session to `attendee` and
     * kept the cookie, and it was open three ways: a token without
     * `signedInAt` was judged by `iat`, which every refresh re-stamps, so one
     * refresh revived it; a database read that failed was not a refusal; and
     * a demoted cookie still read as the old role to the Edge middleware. It
     * throws now, and NextAuth turns a throwing callback into no session for
     * `getServerSession` and a cleared cookie from its session route. So does
     * a read that fails: no answer from the database is no privileges.
     *
     * `trigger: "update"` and whatever `session` it carries are not read: an
     * update is a refresh like any other, and nothing the client sends can
     * move `signedInAt`.
     */
    async jwt({ token, user }) {
      if (user) {
        // A new session, from whichever provider: it has just proved who it is.
        return { ...token, sub: user.id, role: (user as User & { role: user_role }).role, signedInAt: Date.now() }
      }

      const account = token.sub
        ? await db.user.findUnique({
            where: { id: token.sub },
            select: { role: true, suspended_at: true, deletedAt: true, password_changed_at: true, sessions_revoked_at: true },
          })
        : null
      if (!account || isRevoked(token, account)) throw new SessionEnded()

      // `provenAt` written back, so a session that only had `iat` keeps the
      // first one it was judged by rather than its next re-encode's.
      return { ...token, role: account.role, signedInAt: provenAt(token)! }
    },
  },
}

export const getAuth = () => getServerSession(authOptions)
