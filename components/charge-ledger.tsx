"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconLoader2, IconReceipt } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import { cn } from "@/lib/utils"
import {
  advanceCharge,
  pricePlacement,
  type ChargeablePlacement,
  type ChargeLedger,
} from "@/lib/charge-actions"
import { formatDay } from "@/lib/dashboard-format"

/**
 * Money, as minor units, formatted once.
 *
 * `Intl` rather than a template string: it puts the symbol, the grouping and the
 * decimal separator where the locale expects them, and ₹1,25,050 groups
 * differently from $125,050 — a hand-rolled formatter gets that wrong and looks
 * like a bug in the amount.
 */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100)
}


export function ChargeLedgerView({ ledger }: { ledger: ChargeLedger }) {
  const unbilled = ledger.placements.filter((p) => !p.charge)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-1">
        {ledger.totals.map((t) => (
          /*
           * One tile per currency, never a combined figure. Summing minor
           * units across currencies yields a number in no currency at all.
           */
          <MetricTile
            key={t.currency}
            label={`${t.currency} settled`}
            value={money(t.settledMinor, t.currency)}
            hint={`${money(t.agreedMinor, t.currency)} agreed, not yet paid`}
          />
        ))}
        {/*
          The reason this screen lists placements rather than charges. A list
          of charges answers "what have we billed"; the gap is what loses money.
        */}
        <MetricTile
          label="Unbilled"
          value={unbilled.length}
          hint="placements running with no price on them"
        />
      </div>

      {ledger.placements.length === 0 ? (
        <EmptyState
          icon={<IconReceipt />}
          title="Nothing to bill yet"
          description="Approved placements appear here as soon as an organiser attaches a brand to an event."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {ledger.placements.map((p) => (
            <li key={p.placementId} className="py-4">
              <PlacementCharge placement={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlacementCharge({ placement }: { placement: ChargeablePlacement }) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [ref, setRef] = useState("")
  const [settling, setSettling] = useState(false)
  const [pending, start] = useTransition()

  function price() {
    start(async () => {
      try {
        await pricePlacement(placement.placementId, { amount: Number(amount) })
        toast.success("Priced. Mark it agreed once the sponsor accepts.")
        setAmount("")
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not price that")
      }
    })
  }

  function advance(to: "agreed" | "settled" | "void") {
    start(async () => {
      try {
        await advanceCharge(placement.charge!.id, to, to === "settled" ? ref : undefined)
        toast.success(
          to === "void" ? "Voided. Raise a corrected charge when you are ready." : `Marked ${to}.`
        )
        setRef("")
        setSettling(false)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update that")
      }
    })
  }

  const charge = placement.charge

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-muted-foreground">
            <span className="font-medium text-foreground">{placement.brandName}</span>
            <span>· {placement.phase}</span>
            {/* The one word in colour is the one that loses money: a running
                placement with no price on it. A void charge is the other. */}
            {charge ? (
              <span className={cn(charge.status === "void" && "font-bold text-destructive")}>
                · {charge.status}
              </span>
            ) : (
              <span className="font-bold text-destructive">· unbilled</span>
            )}
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">
            {placement.ownerName ?? "Unclaimed brand"} ·{" "}
            <Link
              href={`/dashboard/events/${placement.eventId}`}
              className="underline-offset-4 hover:underline"
            >
              {placement.eventTitle}
            </Link>{" "}
            · {formatDay(placement.eventStart.toISOString())}
          </span>
        </div>
        <span className="shrink-0 text-[0.8125rem] text-muted-foreground">
          {/*
            Exposures, not reach. The same person recurs once per interval, so
            summing sends across a night counts the regulars many times — the
            column comment on `sponsored_message_sends.members` says the same.
          */}
          {placement.sends === 0
            ? "Nothing sent yet"
            : `${placement.sends} send${placement.sends === 1 ? "" : "s"}`}
        </span>
      </div>

      {charge ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[1.0625rem] font-bold">
            {money(charge.amountMinor, charge.currency)}
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">
            priced by {charge.pricedByName ?? "someone since deleted"}
            {charge.externalRef ? ` · ${charge.externalRef}` : ""}
          </span>

          {settling ? (
            <div className="flex w-full items-center gap-2">
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="Payment reference"
                className="max-w-xs"
                autoFocus
              />
              <Button size="sm" disabled={pending || ref.trim().length < 3} onClick={() => advance("settled")}>
                {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
                Mark settled
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSettling(false)}>
                Cancel
              </Button>
              <span className="text-[0.75rem] text-faint-foreground">
                A settlement with no reference cannot be checked against a bank
                statement, which is the only reason this row exists.
              </span>
            </div>
          ) : (
            <div className="ml-auto flex gap-2">
              {charge.status === "draft" ? (
                <Button size="sm" disabled={pending} onClick={() => advance("agreed")}>
                  Sponsor accepted
                </Button>
              ) : null}
              {charge.status === "agreed" ? (
                <Button size="sm" disabled={pending} onClick={() => setSettling(true)}>
                  Payment received
                </Button>
              ) : null}
              {charge.status !== "void" ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => advance("void")}>
                  Void
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in ₹"
            className="max-w-[180px]"
          />
          <Button size="sm" disabled={pending || !(Number(amount) > 0)} onClick={price}>
            Raise charge
          </Button>
        </div>
      )}
    </div>
  )
}
