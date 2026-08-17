import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { canAccessDashboard } from "@/lib/rbac"
import { getMyBrand } from "@/lib/sponsor-actions"

import { BrandForm } from "./brand-form"

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
  if (!canAccessDashboard(session.user.role)) redirect("/dashboard")

  const brand = await getMyBrand()

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
          Your name and logo appear beside every sponsored message you place. The
          room is pseudonymous — attendees are shown a nickname, so your brand is
          the only named participant in it. Worth getting right.
        </p>
        <BrandForm brand={brand} />
      </div>
    </div>
  )
}
