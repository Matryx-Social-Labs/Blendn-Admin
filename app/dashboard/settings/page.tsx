import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { getAccount, listSessions } from "@/lib/account-actions"

import { SettingsForm } from "./settings-form"

export const dynamic = "force-dynamic"

/**
 * Account settings.
 *
 * The highest-priority missing screen: the approval email we send every new
 * host says *"Change the password after your first sign-in"* and there was
 * nowhere in the product to do it. We generated a password, emailed it in
 * plaintext, and offered no way to rotate it.
 *
 * Notification preferences are deliberately **not** here. The design includes
 * them, but Blend'n does not send a weekly digest, a flag alert, or a product
 * update — so the toggles would control nothing. That is the same dead-control
 * problem as the date chip this redesign removed, and the honest version is to
 * add them alongside the first email they govern.
 */
export default async function SettingsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const [account, sessions] = await Promise.all([getAccount(), listSessions()])

  return <SettingsForm account={account} sessionCount={sessions.length} />
}
