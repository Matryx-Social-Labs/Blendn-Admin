import Link from "next/link"
import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { venueOwnerFacts } from "@/lib/venue-owner-facts"
import { StatLine } from "@/components/dashboard/kit"
import { RoleUsersTable } from "@/components/role-users-table"
import { Button } from "@/components/ui/button"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/venue-owners")

export default async function VenueOwnersPage() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const users = await getRoleUsers("venue_owner")
  // After the gate above: this read is plain, not a server action.
  const facts = await venueOwnerFacts(users.map((u) => u.id))

  const venues = Object.values(facts).reduce((sum, f) => sum + f.venues, 0)
  const waiting = Object.values(facts).filter((f) => f.pendingClaims > 0).length

  return (
    <div className="flex flex-col gap-4">
      <RoleUsersTable
        users={users}
        role="venue_owner"
        roleLabel="Venue owner"
        detailBasePath="/dashboard/venue-owners"
        facts={facts}
        summary={
          /*
            The kit's line: accounts, the venues their organisations hold, and
            the one count that wants a decision. "Venues held" is a sum over
            people, as the table below is, so two owners at one company count
            their shared buildings twice.
          */
          <StatLine
            items={[
              { value: users.length, label: users.length === 1 ? "venue owner" : "venue owners" },
              { value: venues, label: venues === 1 ? "venue held" : "venues held" },
              waiting > 0 && {
                value: waiting,
                label: waiting === 1 ? "claim pending" : "claims pending",
                tone: "warning",
              },
            ]}
          />
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="rounded-full">
              <Link href="/dashboard/claims/venues">Review claims</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="rounded-full">
              {/* Admin-created venues land unclaimed, which is how the directory
                  gets seeded before any owner is on the platform. */}
              <Link href="/dashboard/venues/new">Add a venue</Link>
            </Button>
          </>
        }
      />
    </div>
  )
}
