import { PrismaAdapter } from "@auth/prisma-adapter"
import { NextAuthOptions, getServerSession, User, type Profile } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import GoogleProvider from "next-auth/providers/google"
import bcrypt from "bcryptjs"
import { db } from "./db"
import { cookies, headers } from "next/headers"
import { auditLog } from "./audit-log"
import { clientIpFrom } from "./client-ip"
import { COMPANY, isStaffEmail } from "./company"
import { DUMMY_HASH, MAX_EMAIL_LENGTH, refuseOverSigninLimits, settleSigninSuccess, signinIp, signinKeys } from "./dashboard-signin-limits"
import { adminSsoRequired, dashboardGoogleClient } from "./env"
import { KNOWN_DEVICE_MAX_AGE_SECONDS, isKnownDevice, knownDeviceCookie } from "./known-device"
import { logger } from "./logger"
import { sessionAccount, signinAccount } from "./org-membership"
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
 * accepting it is what moves them out of `attendee`. That session is `inviteOnly`: `getAuth` answers null for it, so no
 * route or action sees it, only the accept route through `getInviteAuth`. The jwt callback asks this again on every read,
 * so it ends with the invite.
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

/*
 * Who was in, and from where (SCRUM-1238; security audit 2026-11-25 finding 8), whichever door they came through. Not
 * awaited: `auditLog` catches its own failures, so a slow or failing write neither holds up nor refuses a sign-in.
 */
function recordDashboardSignin(userId: string, role: user_role, provider: "credentials" | "google", ipAddress?: string): void {
  auditLog({ action: "auth.dashboard_signin", resource: "user", resourceId: userId, userId, ipAddress, details: { provider } })
  if (role === "app_admin") logger.warn("Admin dashboard sign-in", { userId, ipAddress })
}

/** The request's address inside a NextAuth event, which is handed no request. Never a reason to fail a sign-in. */
async function requestIp(): Promise<string | undefined> {
  try {
    return clientIpFrom(await headers())
  } catch {
    return undefined
  }
}

type GoogleClaims = Profile & { email_verified?: boolean; hd?: string }

/**
 * Whether a Google sign-in is platform staff, and if so the link from that Google account to their row (SCRUM-1241).
 *
 * Google has verified the id token by now; these are its claims. In: a verified address on the staff domain, from the
 * company Workspace (`hd`), belonging to a live, unsuspended `app_admin`. The `hd` claim is what Google says about the
 * account; the `hd` sent with the request is only a hint to its account picker.
 *
 * The link is written here, to the row just checked, and never by NextAuth: its handler would link an unlinked account
 * to whichever session is already in the browser, or to whatever row the e-mail matches, or create one (the adapter
 * below refuses both writes). A row already linked to another Google account is refused: a Workspace address handed
 * to a new person must not inherit the old one's admin row; an admin removes the old link first. No Google token is
 * kept: nothing here calls Google.
 *
 * Every refusal writes nothing and says only "not staff": which check failed is in the log, not on the page.
 */
async function admitStaffGoogle(sub: string, profile: Profile | undefined): Promise<boolean> {
  const claims = profile as GoogleClaims | undefined
  const email = claims?.email?.trim().toLowerCase()
  const refuse = (reason: string) => {
    logger.warn("Staff Google sign-in refused", { reason })
    return false
  }
  if (!sub || !email || claims?.email_verified !== true || claims.hd !== COMPANY.staffEmailDomain || !isStaffEmail(email)) {
    return refuse("not a verified address on the staff Workspace")
  }
  const row = await signinAccount(email)
  if (!row || row.role !== "app_admin" || row.deletedAt || row.suspended_at) return refuse("no live admin with that address")

  const links = await db.account.findMany({
    where: { provider: "google", OR: [{ providerAccountId: sub }, { userId: row.id }] },
    select: { userId: true, providerAccountId: true },
  })
  if (links.some((l) => l.userId !== row.id || l.providerAccountId !== sub)) return refuse("linked to another Google account or row")
  if (links.length === 0) {
    // Two first sign-ins at once: one row wins, and both read back which.
    await db.account.createMany({ data: [{ userId: row.id, type: "oauth", provider: "google", providerAccountId: sub }], skipDuplicates: true })
    const link = await db.account.findUnique({
      where: { provider_providerAccountId: { provider: "google", providerAccountId: sub } },
      select: { userId: true },
    })
    if (link?.userId !== row.id) return refuse("linked to another row")
  }
  return true
}

const refuseAdapterWrite = (): never => {
  throw new Error("The dashboard never creates or links an account through NextAuth")
}
const googleClient = dashboardGoogleClient()

export const authOptions: NextAuthOptions = {
  // Reads only: no sign-in creates a user, and the one link is written by `admitStaffGoogle`.
  adapter: { ...PrismaAdapter(db), createUser: refuseAdapterWrite, linkAccount: refuseAdapterWrite },
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    // A refused Google sign-in lands back on the form, which says it in its own words (app/login/page.tsx).
    error: "/login",
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
        const user = await signinAccount(email)

        const isValid = await bcrypt.compare(credentials.password, user?.password ?? DUMMY_HASH)
        /*
         * An admin signs in with Google once ADMIN_SSO_REQUIRED is on (SCRUM-1241). Refused as a wrong password is, and
         * after the compare, so neither the answer nor its time says the password was right: the mobile door still
         * takes it. The form tells a staff address where to go instead.
         */
        const ssoOnly = adminSsoRequired() && user?.role === "app_admin"
        if (!user?.password || !isValid || ssoOnly) {
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
        // From the memberships, not the row (SCRUM-1247): an attendee in a live organisation is its host.
        const role = user.dashboardRole
        if (!canAccessDashboard(role) && !(await hasLiveInvite(user.email))) {
          throw new Error(APP_ONLY_SIGNIN)
        }

        recordDashboardSignin(user.id, role, "credentials", signinIp(req?.headers))

        return { id: user.id, email: user.email, name: user.name, role }
      },
    }),
    // Platform staff, with the company Google account. Registered only when the dashboard's own client is configured.
    ...(googleClient
      ? [
          GoogleProvider({
            ...googleClient,
            authorization: { params: { hd: COMPANY.staffEmailDomain, prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  callbacks: {
    /** Default deny: Credentials has decided in `authorize`; Google is decided by `admitStaffGoogle`; nothing else exists. */
    async signIn({ account, profile }) {
      if (account?.provider === "credentials") return true
      if (account?.provider === "google") return admitStaffGoogle(account.providerAccountId, profile)
      return false
    },
    async session({ session, token }) {
      if (!token || !session.user) return session
      return {
        ...session,
        user: { ...session.user, id: token.sub!, role: token.role, signedInAt: token.signedInAt, inviteOnly: token.inviteOnly === true },
      }
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
        const role = (user as User & { role: user_role }).role
        return { ...token, sub: user.id, role, signedInAt: Date.now(), inviteOnly: !canAccessDashboard(role) }
      }

      const account = token.sub ? await sessionAccount(token.sub) : null
      if (!account || isRevoked(token, account)) throw new SessionEnded()
      // The claim the middleware, nav and pages read: from the memberships, in this same one statement (SCRUM-1247).
      const role = account.dashboardRole
      // No dashboard role is an invite's session or none: it ends with the invite, and a host who leaves their last org ends at once.
      const inviteOnly = !canAccessDashboard(role)
      if (inviteOnly && !(account.email && (await hasLiveInvite(account.email)))) throw new SessionEnded()

      // `provenAt` written back, so a session that only had `iat` keeps the
      // first one it was judged by rather than its next re-encode's.
      return { ...token, role, signedInAt: provenAt(token)!, inviteOnly }
    },
  },
  events: {
    // After the session is made, so a sign-in the handler still refuses leaves no row. Credentials records in `authorize`.
    async signIn({ user, account }) {
      if (account?.provider !== "google") return
      recordDashboardSignin(user.id, (user as User & { role: user_role }).role, "google", await requestIp())
    },
  },
}

/** The session every route and action reads. Null for an `inviteOnly` one: all it may do is accept (`getInviteAuth`). */
export const getAuth = async () => {
  const session = await getServerSession(authOptions)
  return session?.user?.inviteOnly ? null : session
}

/** For the accept route alone: the same session, an invite's included. */
export const getInviteAuth = () => getServerSession(authOptions)
