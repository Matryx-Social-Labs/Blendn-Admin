import { redirect } from "next/navigation"
import { IconBuilding, IconCircleCheck } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getOrganisations } from "@/lib/onboarding-actions"
import { formatDay } from "@/lib/dashboard-format"

import { OrgStatusControl } from "./status-control"
import { OrgSponsorControl } from "./sponsor-control"
import { OrgAnalyticsGrantControl } from "./analytics-grant-control"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/organisations")

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

  /*
   * The kit's Organisations: one bordered list, divided, controls to the right.
   * One box around every row rather than a card each — a Panel groups, and a
   * card per organisation would be thirty boxes competing for the eye.
   */
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-panel border border-border bg-card">
      {orgs.map((org) => (
        <li key={org.id} className="flex flex-col gap-2 px-5 py-4 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between @3xl/main:gap-6">
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
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.78125rem] text-faint-foreground">
              <span>{org.memberCount} member{org.memberCount === 1 ? "" : "s"}</span>
              <span>{org.eventCount} event{org.eventCount === 1 ? "" : "s"}</span>
              <span>{org.venueCount} venue{org.venueCount === 1 ? "" : "s"}</span>
              <span>since {formatDay(org.created_at.toISOString())}</span>
              {org.domains.map((d) => (
                <span key={d.domain} className={d.verified ? "inline-flex items-center gap-1 text-success" : "inline-flex items-center gap-1"}>
                  {d.verified ? <IconCircleCheck aria-hidden className="size-3.5" /> : null}
                  {d.domain}
                  {d.verified ? "" : " (unverified)"}
                </span>
              ))}
            </p>
          </div>

          {/* The controls, small and to the right. Suspending keeps every
              event, check-in and message; the control says so when opened. */}
          <div className="flex shrink-0 flex-wrap items-start gap-2 @3xl/main:flex-col @3xl/main:items-end">
            <OrgSponsorControl
              orgId={org.id}
              maySponsor={org.may_sponsor}
              status={org.status}
              name={org.display_name}
            />
            <OrgAnalyticsGrantControl
              subjectId={org.id}
              name={org.display_name}
              status={org.status}
              grant={org.analytics.grant ? { expiresAt: org.analytics.grant.expiresAt?.toISOString() ?? null } : null}
              paid={org.analytics.paid ? { id: org.analytics.paid.id, expiresAt: org.analytics.paid.expiresAt?.toISOString() ?? null } : null}
            />
            <OrgStatusControl orgId={org.id} status={org.status} name={org.display_name} />
          </div>
        </li>
      ))}
    </ul>
  )
}
