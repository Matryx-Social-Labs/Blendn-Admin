import { redirect } from "next/navigation"
import { IconHistory } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getAuditLog } from "@/lib/audit-actions"

import { AuditTimeline } from "./timeline"

export const dynamic = "force-dynamic"

/**
 * The audit log.
 *
 * `audit_logs` has been written by every sensitive action in the product since
 * it shipped — role changes, suspensions, moderation decisions, invite
 * domain-overrides, org approvals — and nothing ever read it back.
 *
 * Two audiences: a platform admin sees the whole table; an org owner or admin
 * sees only what their own members did. The scoping is enforced in
 * `lib/audit-actions.ts`, not here, so a route added later cannot forget it.
 */
export default async function AuditPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  let page
  try {
    page = await getAuditLog()
  } catch {
    // Thrown for a host who is only `staff` — they have no org to audit.
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-muted-foreground">
        {page.scopedToOrg
          ? "Everything your organisation's members have done. Actions by other organisations are not shown."
          : "Every recorded action across the platform. Written automatically — entries cannot be edited or deleted from the dashboard."}
      </p>

      {page.entries.length === 0 ? (
        <EmptyState
          icon={<IconHistory />}
          title="Nothing recorded yet"
          description="Role changes, suspensions, moderation decisions, invites and approvals are written here as they happen."
        />
      ) : (
        <AuditTimeline page={page} />
      )}
    </div>
  )
}
