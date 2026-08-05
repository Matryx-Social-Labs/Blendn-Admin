import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { hashInviteToken, inviteState } from "@/lib/org-invites"

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
      `org:accept-invite:${r.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"}`,
  })
  if (limited) return limited

  try {
    const session = await getAuth()
    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: "Sign in first, then open the invite link again.", needsSignIn: true },
        { status: 401 }
      )
    }

    const { token } = (await req.json()) as { token?: string }
    if (!token) return NextResponse.json({ success: false, error: "Missing token." }, { status: 400 })

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
        org: { select: { display_name: true, status: true } },
      },
    })

    if (!invite) {
      return NextResponse.json(
        { success: false, error: "This invite link is not valid." },
        { status: 400 }
      )
    }

    const state = inviteState(invite, session.user.email ?? "")
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

    // Already a member — treat as success. They clicked twice, or were added by
    // hand in between; either way they are in and an error would be confusing.
    const existing = await db.organisation_members.findUnique({
      where: { org_id_user_id: { org_id: invite.org_id, user_id: session.user.id } },
      select: { id: true },
    })
    if (existing) {
      await db.organisation_invites.update({
        where: { id: invite.id },
        data: { accepted_at: new Date() },
      })
      return NextResponse.json({ success: true, orgName: invite.org.display_name, alreadyMember: true })
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
        data: { org_id: invite.org_id, user_id: session.user.id, role: invite.role },
      })

      // An attendee accepting a host invite needs dashboard access, which is
      // gated on the User role rather than on membership. Only ever a promotion
      // out of `attendee` — an existing organizer is not demoted or changed.
      if (session.user.role === "attendee") {
        await tx.user.update({ where: { id: session.user.id }, data: { role: "organizer" } })
      }
    })

    auditLog({
      userId: session.user.id,
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
      roleChanged: session.user.role === "attendee",
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
