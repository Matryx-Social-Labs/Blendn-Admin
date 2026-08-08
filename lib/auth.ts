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
          select: { role: true },
        })
        // A deleted user keeps no privilege; `canAccessDashboard` rejects
        // `attendee`, so this fails closed rather than throwing mid-request.
        token.role = fresh?.role ?? ("attendee" as user_role)
      }

      return token
    },
  },
}

export const getAuth = () => getServerSession(authOptions)
