import { redirect } from "next/navigation"
import { IconBuilding } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getMyOrgs, getOrgMembers } from "@/lib/org-actions"
import { orgPermissions } from "@/lib/org-permissions"
import { emailConfigured } from "@/lib/email"

import { OrgPanel } from "./panel"

export const dynamic = "force-dynamic"

/**
 * An organisation managing itself.
 *
 * Deliberately not for platform admins: they get /dashboard/organisations,
 * which is a different job. An admin acting here would be recorded as though
 * the org's own owner did it.
 */
export default async function OrganisationPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role === "app_admin") redirect("/dashboard/organisations")

  const orgs = await getMyOrgs()

  if (orgs.length === 0) {
    return (
      <EmptyState
        icon={<IconBuilding />}
        title="No organisation"
        description="Your account isn't attached to an organisation yet, which is why events and venues don't appear. Contact support — this shouldn't happen."
      />
    )
  }

  // An agency belonging to several orgs gets one panel each, loaded in parallel.
  const panels = await Promise.all(
    orgs.map(async (org) => ({ org, data: await getOrgMembers(org.id) }))
  )

  return (
    <div className="flex flex-col gap-6">
      {!emailConfigured() ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-[0.8125rem] leading-6">
          <strong className="font-semibold">Email is not configured.</strong> Invites still work,
          but nothing is sent — you&apos;ll get a link to pass on yourself.
        </div>
      ) : null}

      {panels.map(({ org, data }) => (
        <OrgPanel
          key={org.id}
          org={org}
          {...data}
          permissions={orgPermissions(org.myRole)}
        />
      ))}
    </div>
  )
}
