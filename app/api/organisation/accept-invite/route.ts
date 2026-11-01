import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { currentUser } from "@/lib/current-user"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { hashInviteToken, inviteState } from "@/lib/org-invites"
import { readJson } from "@/lib/api-input"

/**
 * Accepting an invitation to an organisation.
 *
 * The sharp edges, all of which are silent failures if got wrong:
 *
 *   - the token is looked up **by hash**, so the database never holds a usable
 *     invitation
 *   - it is bound to the invited address and refused for anyone else, so a
 *     forwarded link is not a way in
 *   - it is single-use and marked accepted in the same transaction that creates
 *     the membership, so two concurrent clicks cannot make two memberships
 *   - the membership is created at **the invited role**, never at whatever the
 *     client asks for — the request body carries only the token
 *
 * The caller must be signed in. There is no account creation here: an invite is
 * permission to join a company, not a way to mint a login, and conflating them
 * would make the token a self-serve signup for anyone who intercepts it.
 */

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    keyGenerator: (r) =>
      `org:accept-invite:${clientIpFrom(r.headers)}`,
  })
  if (limited) return limited

  try {
    /*
     * The person, through `currentUser()`: the role the database holds and a
     * session it has not ended (step 18 security review, L4). The address the
     * invite is bound to is read from the row too — the session's email was
     * minted at sign-in, and an address changed since then is not the one
     * the invitation was sent to.
     */
    const caller = await currentUser()
    const user = caller
      ? { ...caller, email: (await db.user.findUniqueOrThrow({ where: { id: caller.id }, select: { email: true } })).email }
      : null
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Sign in first, then open the invite link again.", needsSignIn: true },
        { status: 401 }
      )
    }

    const { token } = ((await readJson(req)) ?? {}) as { token?: unknown }
    if (typeof token !== "string" || !token) return NextResponse.json({ success: false, error: "Missing token." }, { status: 400 })

    const invite = await db.organisation_invites.findUnique({
      where: { token_hash: hashInviteToken(token) },
      select: {
        id: true,
        org_id: true,
        email: true,
        role: true,
        expires_at: true,
        accepted_at: true,
        revoked_at: true,
        invited_by: true,
        org: { select: { display_name: true, status: true } },
      },
    })

    if (!invite) {
      return NextResponse.json(
        { success: false, error: "This invite link is not valid." },
        { status: 400 }
      )
    }

    /*
     * Already a member — success, before the state check.
     *
     * This branch sat below `inviteState`, which reports "used" the moment
     * `accepted_at` is set, so the second of two accepts by the same person
     * got "This invite has already been used." Driven: the page's effect ran
     * the accept twice on sign-in and showed the failure state to somebody
     * who had just been let in. Being in the organisation is the outcome the
     * invite exists for; the token's state after that is bookkeeping.
     */
    const member = await db.organisation_members.findUnique({
      where: { org_id_user_id: { org_id: invite.org_id, user_id: user.id } },
      select: { id: true },
    })
    if (member) {
      return NextResponse.json({ success: true, orgName: invite.org.display_name, alreadyMember: true })
    }

    const state = inviteState(invite, user.email)
    if (state !== "valid") {
      const message = {
        used: "This invite has already been used.",
        expired: "This invite has expired. Ask them to send a new one.",
        revoked: "This invite was withdrawn.",
        wrong_recipient: `This invite was sent to ${invite.email}. Sign in as that address to accept it.`,
      }[state]
      return NextResponse.json({ success: false, error: message }, { status: 400 })
    }

    if (invite.org.status === "suspended") {
      return NextResponse.json(
        { success: false, error: "That organisation is suspended." },
        { status: 403 }
      )
    }


    await db.$transaction(async (tx) => {
      // updateMany with accepted_at: null in the filter is the concurrency
      // guard — the second of two simultaneous clicks matches zero rows.
      const claimed = await tx.organisation_invites.updateMany({
        where: { id: invite.id, accepted_at: null, revoked_at: null },
        data: { accepted_at: new Date() },
      })
      if (claimed.count === 0) throw new Error("ALREADY_ACCEPTED")

      await tx.organisation_members.create({
        data: { org_id: invite.org_id, user_id: user.id, role: invite.role },
      })

      // An attendee accepting a host invite needs dashboard access, which is
      // gated on the User role rather than on membership. Only ever a promotion
      // out of `attendee` — an existing organizer is not demoted or changed.
      // As the person who invited them: a sponsor or venue org's invite must not
      // open event creation, which `organizer` would (security review of SCRUM-984).
      if (user.role === "attendee") {
        const inviter = await tx.user.findUnique({ where: { id: invite.invited_by }, select: { role: true } })
        const role = inviter?.role === "venue_owner" || inviter?.role === "sponsor" ? inviter.role : "organizer"
        await tx.user.update({ where: { id: user.id }, data: { role } })
      }
    })

    auditLog({
      userId: user.id,
      action: "org.invite.accepted",
      resource: "organisation",
      resourceId: invite.org_id,
      details: { inviteId: invite.id, role: invite.role },
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({
      success: true,
      orgName: invite.org.display_name,
      role: invite.role,
      // The session's role claim is now stale if they were an attendee; the
      // client signs out and back in rather than us minting a new token here.
      roleChanged: user.role === "attendee",
    })
  } catch (err) {
    if (err instanceof Error && err.message === "ALREADY_ACCEPTED") {
      return NextResponse.json(
        { success: false, error: "This invite has already been used." },
        { status: 400 }
      )
    }
    logger.error("Invite accept failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ success: false, error: "Something went wrong." }, { status: 500 })
  }
}
