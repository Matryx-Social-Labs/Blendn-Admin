import { NextRequest, NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { emailDomain } from "@/lib/org-invites"

/**
 * Asking to join an organisation.
 *
 * The approval half of this shipped with the tenant model — the table, the
 * owner's approve/decline screen, all of it — and the *requester's* half had no
 * UI at all. Someone whose account was not attached to an org saw
 * "Contact support — this shouldn't happen" and stopped there.
 *
 * You may only request to join an organisation that has **verified the domain
 * of your own email address**. That is what makes this safe to expose: the
 * request is not "let me into any company I can name", it is "I have an address
 * at a domain this company proved it controls". The org's own admin still
 * decides, and approval grants `staff` and nothing more.
 */

export async function GET() {
  const session = await getAuth()
  if (!session?.user?.email) return new NextResponse("Unauthorized", { status: 401 })

  const domain = emailDomain(session.user.email)
  if (!domain) return NextResponse.json({ matches: [], domain: null })

  const [claims, existing] = await Promise.all([
    db.organisation_domains.findMany({
      where: { domain, verified_at: { not: null } },
      select: { org: { select: { id: true, display_name: true, status: true } } },
    }),
    db.organisation_join_requests.findMany({
      where: { user_id: session.user.id },
      select: { org_id: true, status: true },
    }),
  ])

  const requestState = new Map(existing.map((r) => [r.org_id, r.status]))

  return NextResponse.json({
    domain,
    matches: claims
      // A suspended org is not somewhere to be sent.
      .filter((c) => c.org.status !== "suspended")
      .map((c) => ({
        id: c.org.id,
        name: c.org.display_name,
        requestState: requestState.get(c.org.id) ?? null,
      })),
  })
}

export async function POST(req: NextRequest) {
  try {
    const session = await getAuth()
    if (!session?.user?.email) return new NextResponse("Unauthorized", { status: 401 })

    const limited = await rateLimit(req, userLimit("heavy", "org:join-request", session.user.id))
    if (limited) return limited

    const { orgId } = (await req.json()) as { orgId?: string }
    if (!orgId) return NextResponse.json({ error: "Missing organisation." }, { status: 400 })

    const domain = emailDomain(session.user.email)
    if (!domain) return NextResponse.json({ error: "Invalid email address." }, { status: 400 })

    // Re-checked server-side. The GET is a convenience; this is the gate.
    const claim = await db.organisation_domains.findFirst({
      where: { org_id: orgId, domain, verified_at: { not: null } },
      select: { id: true, org: { select: { status: true } } },
    })
    if (!claim || claim.org.status === "suspended") {
      // Same message either way: distinguishing them tells someone probing
      // which organisations exist and which domains they have verified.
      return NextResponse.json(
        { error: "You can only ask to join an organisation that has verified your email domain." },
        { status: 403 }
      )
    }

    const already = await db.organisation_members.findUnique({
      where: { org_id_user_id: { org_id: orgId, user_id: session.user.id } },
      select: { id: true },
    })
    if (already) return NextResponse.json({ ok: true, alreadyMember: true })

    await db.organisation_join_requests.upsert({
      where: { org_id_user_id: { org_id: orgId, user_id: session.user.id } },
      // Re-asking after a decline resets to pending rather than being refused
      // outright: circumstances change, and the org admin sees it either way.
      update: { status: "pending", decided_by: null, decided_at: null },
      create: { org_id: orgId, user_id: session.user.id, status: "pending" },
    })

    auditLog({
      userId: session.user.id,
      action: "org.join_request.created",
      resource: "organisation",
      resourceId: orgId,
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    logger.error("Join request failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 })
  }
}
