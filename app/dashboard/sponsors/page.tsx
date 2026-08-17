import { redirect } from "next/navigation"

import { SponsorRegisterView } from "@/components/sponsor-register"
import { getAuth } from "@/lib/auth"
import { getSponsorRegister } from "@/lib/sponsor-actions"

export const dynamic = "force-dynamic"

/**
 * Every brand on the platform, duplicates first.
 *
 * Organisers create unclaimed brands from the event messaging screen, which is
 * where duplicates come from: two organisers each add "Red Bull" a week apart and
 * neither sees the other's. Nothing prevents that — a stricter picker would just
 * block the legitimate case of two genuinely different brands with similar names
 * — so it is resolved here, by a person, after the fact.
 */
export default async function SponsorsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const register = await getSponsorRegister()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
          A brand is created either by its own organisation or by an organiser
          adding it to an event. The second kind is unclaimed until the company
          files a claim.
        </p>
      </div>
      <SponsorRegisterView register={register} />
    </div>
  )
}
