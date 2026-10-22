import { redirect } from "next/navigation"

import { Panel } from "@/components/dashboard/kit"
import { ClaimBrand } from "@/components/claim-brand"
import { getAuth } from "@/lib/auth"
import { mayReachRoute } from "@/lib/dashboard-nav"
import { getMyBrand } from "@/lib/sponsor-actions"
import { getMyClaims } from "@/lib/sponsor-claim-actions"

import { BrandForm } from "./brand-form"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/brand")

export const dynamic = "force-dynamic"

/**
 * The sponsor's brand: what an attendee sees beside a sponsored message.
 *
 * One form, no dashboard chrome. There is exactly one brand per organisation and
 * four fields on it, so tiles and charts here would be decoration — the screen's
 * whole job is "get this right once".
 */
export default async function BrandPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  // From the nav's own `allowedRoles`, so the menu and the gate cannot
  // disagree. This called `canAccessDashboard`, which is true for all four
  // dashboard roles, while the nav has always presented this as sponsor-only.
  if (!mayReachRoute(session.user.role, "/dashboard/brand")) redirect("/dashboard")

  const [brand, claims] = await Promise.all([getMyBrand(), getMyClaims()])
  const claimPending = !brand && claims.some((c) => c.status === "pending")

  return (
    <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,1fr)_340px] @3xl/main:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        {/*
          Claim first, create second. An organiser may already have added this
          brand while setting up an event, and creating a second row splits its
          placements across two brands that an admin then has to merge.
        */}
        {brand ? null : <ClaimBrand claims={claims} />}
        {/*
          The create form is withheld while a claim is pending, and not just for
          tidiness: creating a brand gives the organisation one, and
          `decideSponsorClaim` then refuses to approve the claim. Offering both
          at once is offering to destroy the claim they just filed.
        */}
        {claimPending ? null : <BrandForm brand={brand} />}
      </div>

      {/* The screen's memorable detail: the brand as an attendee reads it. The
          room is pseudonymous, so it is the only named participant there. */}
      <Panel title="How it appears">
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-[0.6875rem] font-bold"
          >
            {(brand?.name ?? "Brand").slice(0, 2).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[0.71875rem] text-faint-foreground">Sponsored · {brand?.name ?? "Your brand"}</span>
            <span className="rounded-xl border border-[color-mix(in_oklch,var(--chart-3)_40%,transparent)] bg-[color-mix(in_oklch,var(--chart-3)_18%,var(--card))] px-3 py-2 text-[0.84375rem] leading-5">
              Your approved message, in the room&apos;s chat.
            </span>
          </div>
        </div>
        <p className="text-[0.75rem] leading-5 text-muted-foreground">
          Attendees are shown nicknames, so your brand is the only named participant in the room.
        </p>
      </Panel>
    </div>
  )
}
