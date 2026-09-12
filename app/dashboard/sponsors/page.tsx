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

  // The header says what the page is; the register says the rest.
  return <SponsorRegisterView register={register} />
}
