import { PrismaAdapter } from "@auth/prisma-adapter"
import { NextAuthOptions, getServerSession, User } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { db } from "./db"
import { clientNetworkFrom } from "./client-ip"
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW } from "./constants"
import { forget, hit } from "./rate-limit-store"
import { APP_ONLY_SIGNIN, SIGNIN_RATE_LIMITED, canAccessDashboard } from "./rbac"
import { SessionEnded, isRevoked, provenAt } from "./session-revocation"
import type { user_role } from "@prisma/client"

/*
 * A real cost-12 hash of nothing anyone knows. An unknown email is compared
 * against it so the response takes as long as a known one (audit L1: 0.25 s vs
 * 0.64 s named the accounts that exist).
 */
const DUMMY_HASH = "$2b$12$O.tIGjDT8kuGET3q.N9fd.iBNLaB2NnxO7PopJJfIp.ozxgF47CE2"

/*
 * Both sign-in limits, counted here because authorize() is the one place every
 * request path to a password check reaches. They used to match the raw URL in
 * the route and a percent-encoded `%63redentials` walked around them (WEB H1).
 *
 * - Per network (the /64 for IPv6): 5 attempts in 15 minutes, as before.
 * - Per email, across every network: 50 wrong passwords in 15 minutes. Counted
 *   before the password is read so parallel guesses cannot all slip under it,
 *   and cleared by a correct password, so only FAILURES accumulate. The ceiling
 *   is high because anyone can spend it against a name; a person on their own
 *   network is held to the network limit first, so an attacker elsewhere has to
 *   bring ten networks to lock an operator out.
 *
 * The account key is the typed email whether or not it exists, so the cap is no
 * oracle. Past either cap the right password is refused too. Both are
 * fail-closed where Redis is configured. Throws, never returns null, so the
 * form can say "wait" rather than "wrong password".
 */
const signinKeys = (email: string, headers: Record<string, unknown> | undefined) => ({
  network: `rl:auth:dashboard-signin:${clientNetworkFrom({
    get: (name) => (typeof headers?.[name] === "string" ? (headers[name] as string) : null),
  })}`,
  account: `rl:auth:dashboard-signin:acct:${email}`,
})

async function refuseOverSigninLimits(keys: { network: string; account: string }): Promise<void> {
  const windowMs = RATE_LIMIT_WINDOW.DASHBOARD_SIGNIN
  const byNetwork = await hit(keys.network, windowMs, { failClosed: true })
  if (byNetwork.count > RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN) throw new Error(SIGNIN_RATE_LIMITED)
  const byAccount = await hit(keys.account, windowMs, { failClosed: true })
  if (byAccount.count > RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN_ACCOUNT) throw new Error(SIGNIN_RATE_LIMITED)
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
        const keys = signinKeys(email, req?.headers)
        await refuseOverSigninLimits(keys)
        const user = await db.user.findUnique({ where: { email } })

        const isValid = await bcrypt.compare(credentials.password, user?.password ?? DUMMY_HASH)
        if (!user?.password || !isValid) {
          return null
        }
        // Proved who they are: the wrong guesses before it are not held against them.
        await forget(keys.account)

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
        if (!canAccessDashboard(user.role)) {
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
