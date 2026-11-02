import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { routeMetadata } from "@/lib/dashboard-route-content"
import { getMarkets } from "@/lib/market-actions"

import { MarketsManager } from "./manager"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/markets")

export const dynamic = "force-dynamic"

/**
 * The countries and cities people can see in the app, and who previews a
 * country early (travel P5, SCRUM-709). Adding a country is rows, not code.
 * `getMarkets` and every write check the admin role again: the redirect here is
 * the page's courtesy, not its authorisation.
 */
export default async function MarketsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const { markets } = await getMarkets()
  return <MarketsManager markets={markets} />
}
