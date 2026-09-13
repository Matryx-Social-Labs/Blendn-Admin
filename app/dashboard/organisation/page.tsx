import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { getMyOrgs, getOrgMembers } from "@/lib/org-actions"
import { orgPermissions } from "@/lib/org-permissions"
import { emailConfigured } from "@/lib/email"

import { JoinRequest } from "./join-request"
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

  // Not a dead end any more. The approval half of request-to-join shipped with
  // the tenant model and the requester's half had no UI, so someone with no org
  // was told to contact support about a flow that already existed.
  if (orgs.length === 0) return <JoinRequest />

  // An agency belonging to several orgs gets one panel each, loaded in parallel.
  const panels = await Promise.all(
    orgs.map(async (org) => ({ org, data: await getOrgMembers(org.id) }))
  )

  return (
    <div className="flex flex-col gap-6">
      {!emailConfigured() ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-[0.8125rem] leading-6">
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
