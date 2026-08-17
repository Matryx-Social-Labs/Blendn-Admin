import { redirect } from "next/navigation"
import { IconBuilding, IconCircleCheck } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
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
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-muted-foreground">
        Every host on the platform. Suspending stops the organisation operating without deleting
        anyone&apos;s history — events, check-ins and messages stay intact and it can be undone.
      </p>

      {orgs.map((org) => (
        <section
          key={org.id}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="font-semibold">{org.display_name}</h2>
              <p className="text-[0.8125rem] text-muted-foreground">
                {org.legal_name ?? "No legal name"}
                {org.primaryContact
                  ? ` · ${org.primaryContact.name ?? org.primaryContact.email}`
                  : " · no primary contact"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{org.kind}</Badge>
              <Badge
                variant={
                  org.status === "verified"
                    ? "default"
                    : org.status === "suspended"
                      ? "destructive"
                      : "secondary"
                }
              >
                {org.status}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem] text-muted-foreground">
            <span>{org.memberCount} members</span>
            <span>{org.eventCount} events</span>
            <span>{org.venueCount} venues</span>
            <span>since {formatDay(org.created_at.toISOString())}</span>
            {org.gstin ? <span className="font-mono">{org.gstin}</span> : null}
          </div>

          {org.domains.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {org.domains.map((d) => (
                <Badge key={d.domain} variant="outline" className="gap-1 font-normal">
                  {d.verified ? <IconCircleCheck className="size-3.5 text-primary" /> : null}
                  {d.domain}
                  {d.verified ? "" : " (unverified)"}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <OrgStatusControl orgId={org.id} status={org.status} name={org.display_name} />
            <OrgSponsorControl
              orgId={org.id}
              maySponsor={org.may_sponsor}
              status={org.status}
              name={org.display_name}
            />
          </div>
        </section>
      ))}
    </div>
  )
}
