import { PrismaAdapter } from "@auth/prisma-adapter"
import { NextAuthOptions, getServerSession, User } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { db } from "./db"
import type { user_role } from "@prisma/client"

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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        const user = await db.user.findUnique({
          where: { email: credentials.email },
        })

        if (!user || !user.password) {
          return null
        }

        const isValid = await bcrypt.compare(credentials.password, user.password)
        if (!isValid) {
          return null
        }

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

        return { id: user.id, email: user.email, name: user.name, role: user.role }
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.sub!
        session.user.role = token.role
      }
      return session
    },
    /*
     * Re-read the role rather than trusting the claim minted at sign-in.
     *
     * With the JWT strategy there is no session table to clear, and the default
     * session is 30 days. This callback used to write `role` only when `user`
     * was set -- i.e. once, at sign-in -- so a demoted or offboarded admin kept
     * `role: "app_admin"` in a live cookie for up to a month. `middleware.ts`
     * and every server action authorise on that claim, and `actorFor`
     * short-circuits on `app_admin` without touching the database, so nothing
     * downstream would have caught it. They could re-promote themselves with
     * `updateUserRole` and make it permanent.
     *
     * `lib/socket-ops-auth.ts` already re-reads role per connection for exactly
     * this reason; the HTTP path was the one left on the stale claim. The cost
     * is one primary-key lookup per navigation, which is what the socket path
     * has been paying all along.
     */
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id
        token.role = (user as User & { role: user_role }).role
        return token
      }

      if (token.sub) {
        const fresh = await db.user.findUnique({
          where: { id: token.sub },
          select: { role: true, suspended_at: true, deletedAt: true },
        })
        /*
         * A deleted user keeps no privilege; `canAccessDashboard` rejects
         * `attendee`, so this fails closed rather than throwing mid-request.
         *
         * Suspension is read here too, and this is the half that actually ends
         * a live session. Blocking `authorize()` only stops the *next* sign-in;
         * with the JWT strategy there is no session table to clear, so a
         * suspended admin's existing cookie stayed valid for up to thirty days.
         * The suspend transaction called `session.deleteMany()` believing it
         * handled this. There were no rows.
         */
        const blocked = !fresh || fresh.deletedAt !== null || fresh.suspended_at !== null
        token.role = blocked ? ("attendee" as user_role) : fresh.role
      }

      return token
    },
  },
}

export const getAuth = () => getServerSession(authOptions)
