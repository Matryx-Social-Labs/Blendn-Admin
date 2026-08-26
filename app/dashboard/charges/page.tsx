import { redirect } from "next/navigation"

import { ChargeLedgerView } from "@/components/charge-ledger"
import { getAuth } from "@/lib/auth"
import { getChargeLedger } from "@/lib/charge-actions"

export const dynamic = "force-dynamic"

/**
 * What each placement costs and whether it has been paid.
 *
 * A ledger, not a checkout. No payment provider is integrated — the money moves
 * by invoice outside this system, and what is recorded here is what was agreed,
 * so six months later there is one answer instead of a thread in somebody's
 * inbox.
 */
export default async function ChargesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const ledger = await getChargeLedger()

  return (
    <div className="flex flex-col gap-5">
      {/* Two words on this screen mean something specific, and neither is
          guessable from the column heading. That is all this line is for. */}
      <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
        A price becomes a receivable when the sponsor accepts it; settled means the
        money arrived and there is a reference to check it against.
      </p>
      <ChargeLedgerView ledger={ledger} />
    </div>
  )
}
