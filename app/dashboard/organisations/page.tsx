import { redirect } from "next/navigation"
import { IconBuilding, IconCircleCheck } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getOrganisations } from "@/lib/onboarding-actions"
import { formatDay } from "@/lib/dashboard-format"

import { OrgStatusControl } from "./status-control"
import { OrgSponsorControl } from "./sponsor-control"

export const dynamic = "force-dynamic"

/**
 * Every organisation on the platform.
 *
 * The platform-admin counterpart to /dashboard/organisation. Suspending here is
 * the lever that actually stops a bad host: it is reversible, and unlike
 * deleting, it does not cascade away every event, check-in and message
 * belonging to the attendees who went.
 */
export default async function OrganisationsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard/organisation")

  const orgs = await getOrganisations()

  if (orgs.length === 0) {
    return (
      <EmptyState
        icon={<IconBuilding />}
        title="No organisations"
        description="Organisations are created when a host application is approved. Check the onboarding queue."
      />
    )
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {orgs.map((org) => (
        <li key={org.id} className="flex flex-col gap-2 py-4 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between @3xl/main:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-muted-foreground">
              <h2 className="text-[0.9375rem] font-bold text-foreground">{org.display_name}</h2>
              {/* Kind and status are words. Suspended is the one that changes
                  what the org can do, so it is the one in colour. */}
              <span>
                {org.kind} ·{" "}
                <span className={org.status === "suspended" ? "font-bold text-destructive" : undefined}>
                  {org.status}
                </span>
              </span>
            </div>
            <p className="text-[0.8125rem] text-muted-foreground">
              {org.legal_name ?? "No legal name"}
              {org.primaryContact
                ? ` · ${org.primaryContact.name ?? org.primaryContact.email}`
                : " · no primary contact"}
              {org.gstin ? ` · ${org.gstin}` : ""}
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
              <span>{org.memberCount} member{org.memberCount === 1 ? "" : "s"}</span>
              <span>{org.eventCount} events</span>
              <span>{org.venueCount} venues</span>
              <span>since {formatDay(org.created_at.toISOString())}</span>
              {org.domains.map((d) => (
                <span key={d.domain} className="inline-flex items-center gap-1">
                  {d.verified ? <IconCircleCheck className="size-3.5 text-success" /> : null}
                  {d.domain}
                  {d.verified ? "" : " (unverified)"}
                </span>
              ))}
            </p>
          </div>

          {/* The two controls, small and to the right. Suspending keeps every
              event, check-in and message; the control says so when opened. */}
          <div className="flex shrink-0 flex-wrap items-start gap-2 @3xl/main:flex-col @3xl/main:items-end">
            <OrgSponsorControl
              orgId={org.id}
              maySponsor={org.may_sponsor}
              status={org.status}
              name={org.display_name}
            />
            <OrgStatusControl orgId={org.id} status={org.status} name={org.display_name} />
          </div>
        </li>
      ))}
    </ul>
  )
}
