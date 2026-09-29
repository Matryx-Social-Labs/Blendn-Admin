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
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string | string[] }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  /*
   * The action filter runs in the query, over the whole scoped log. It ran in
   * the browser over the newest 100 rows, so an older action read "0 of 406"
   * while it existed (SCRUM-462).
   */
  const { action } = await searchParams
  const filter = typeof action === "string" && action ? action : undefined

  let page
  try {
    page = await getAuditLog({ action: filter })
  } catch {
    // Thrown for a host who is only `staff` — they have no org to audit.
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Scope only. The header already says entries are automatic and never
          editable; what it cannot say is whose actions you are looking at,
          because that depends on who is looking. */}
      <p className="text-[0.8125rem] text-muted-foreground">
        {page.scopedToOrg
          ? "Your organisation's members only — actions by other organisations are not shown."
          : "Every organisation on the platform."}
      </p>

      {/* Empty only when nothing is filtered: a filter with no match keeps its dropdown. */}
      {page.entries.length === 0 && !filter ? (
        <EmptyState
          icon={<IconHistory />}
          title="Nothing recorded yet"
          description="Role changes, suspensions, moderation decisions, invites and approvals are written here as they happen."
        />
      ) : (
        <AuditTimeline page={page} action={filter ?? "all"} />
      )}
    </div>
  )
}
