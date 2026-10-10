"use client"

import { useRef, useState, useTransition } from "react"
import { flushSync } from "react-dom"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconLoader2, IconReceipt } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KpiStrip, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { cn } from "@/lib/utils"
import {
  advanceCharge,
  pricePlacement,
  sendPaymentLink,
  type ChargeablePlacement,
  type ChargeLedger,
} from "@/lib/charge-actions"
import { formatDay, formatNumber } from "@/lib/dashboard-format"
import { refusalMessage } from "@/lib/refusal"

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
    <div className="flex flex-col gap-5">
      <KpiStrip
        items={[
          /*
           * One tile per currency, never a combined figure. Summing minor
           * units across currencies yields a number in no currency at all.
           */
          ...ledger.totals.map((t) => ({
            label: `${t.currency} settled`,
            value: money(t.settledMinor, t.currency),
            hint: `${money(t.agreedMinor, t.currency)} agreed, not yet paid`,
          })),
          /*
            The reason this screen lists placements rather than charges. A list
            of charges answers "what have we billed"; the gap is what loses money.
          */
          { label: "Unbilled", value: unbilled.length, hint: "placements running with no price on them" },
        ]}
      />

      <Panel title="Placements" hint="the row that matters is the one that ran unpriced" bodyClassName="gap-0 px-0 pb-0 pt-3">
        {ledger.placements.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              icon={<IconReceipt />}
              title="Nothing to bill yet"
              description="Approved placements appear here as soon as an organiser attaches a brand to an event."
            />
          </div>
        ) : (
          <ul className="flex flex-col">
            {ledger.placements.map((p) => (
              <li key={p.placementId} className="border-t border-border px-5 py-4">
                <PlacementCharge placement={p} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[0.75rem] text-faint-foreground">
        Sends are exposures, not reach: the same person recurs once per send. Reach is distinct people, held back under 5,
        and its band is what a placement is priced by. A payment link is settled by Razorpay&apos;s webhook; money that
        arrives any other way needs its payment reference.
      </p>
    </div>
  )
}

function PlacementCharge({ placement }: { placement: ChargeablePlacement }) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [ref, setRef] = useState("")
  const [settling, setSettling] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [why, setWhy] = useState("")
  const [pending, start] = useTransition()
  const voidTrigger = useRef<HTMLButtonElement>(null)

  function price() {
    start(async () => {
      try {
        await pricePlacement(placement.placementId, { amount: Number(amount) })
        toast.success("Priced. Mark it agreed once the sponsor accepts.")
        setAmount("")
        router.refresh()
      } catch (err) {
        toast.error(refusalMessage(err, "Could not price that"))
      }
    })
  }

  function sendLink() {
    start(async () => {
      try {
        const out = await sendPaymentLink(placement.charge!.id)
        toast.success(out.reused ? "A link is already out for this charge." : "Payment link sent to the sponsor.")
        router.refresh()
      } catch (err) {
        toast.error(refusalMessage(err, "Could not send a payment link"))
      }
    })
  }

  function advance(to: "agreed" | "settled" | "void") {
    start(async () => {
      try {
        await advanceCharge(
          placement.charge!.id,
          to,
          to === "settled" ? ref : undefined,
          to === "void" ? why : undefined
        )
        toast.success(
          to === "void" ? "Voided. Raise a corrected charge when you are ready." : `Marked ${to}.`
        )
        setRef("")
        setWhy("")
        setSettling(false)
        setVoiding(false)
        router.refresh()
      } catch (err) {
        toast.error(refusalMessage(err, "Could not update that"))
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
        <span className="flex shrink-0 flex-col items-end text-[0.8125rem] text-muted-foreground">
          {/*
            Sends are exposures, not reach. The same person recurs once per
            interval; reach is the distinct people (lib/sponsor-reach.ts).
          */}
          <span>
            {placement.sends === 0
              ? "Nothing sent yet"
              : `${placement.sends} send${placement.sends === 1 ? "" : "s"}`}
          </span>
          {placement.reach ? (
            <span>
              {placement.reach.reach === null
                ? "reach held back · under 5"
                : `${formatNumber(placement.reach.reach)} reached${placement.band ? ` · band ${placement.band.label}` : ""}`}
            </span>
          ) : null}
        </span>
      </div>

      {charge ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[1.0625rem] font-bold">
            {money(charge.amountMinor, charge.currency)}
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">
            priced by {charge.pricedByName ?? "someone since deleted"}
            {/* The charge's life, left to right: a link, then its payment. */}
            {charge.link
              ? ` · ${charge.link.status === "paid" ? "paid by link" : `link ${charge.link.status === "created" ? "sent" : charge.link.status}`} ${charge.link.id}`
              : charge.externalRef
                ? ` · ${charge.externalRef}`
                : ""}
            {charge.status === "settled" && charge.settledAt ? ` · settled ${formatDay(charge.settledAt.toISOString())}` : ""}
          </span>

          {voiding ? (
            // One inline step, in words, like a creative rejection: a void can
            // undo money that arrived and cannot be undone (SCRUM-173).
            <div className="flex w-full max-w-xl flex-col gap-2">
              <Label htmlFor={`void-${charge.id}`} className="text-[0.75rem] leading-snug font-normal text-muted-foreground">
                Why is this charge void? It goes in the audit log and stays on this row.
              </Label>
              <Textarea
                id={`void-${charge.id}`}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                placeholder="e.g. duplicate invoice, re-raised as the October package"
                maxLength={500}
                aria-describedby={`void-${charge.id}-hint`}
                autoFocus
              />
              {/* Before settlement `externalRef` is the pricing note, not a payment. */}
              {charge.status === "settled" && charge.externalRef ? (
                <span className="text-[0.75rem] text-faint-foreground">
                  It was settled with reference {charge.externalRef}. Voiding it does not refund the sponsor.
                </span>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending || why.trim().length < 10}
                  onClick={() => advance("void")}
                >
                  {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
                  Void {money(charge.amountMinor, charge.currency)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // Back to the button that opened this, not to the page top.
                    flushSync(() => setVoiding(false))
                    voidTrigger.current?.focus()
                  }}
                >
                  Back
                </Button>
                <span id={`void-${charge.id}-hint`} className="text-[0.75rem] text-faint-foreground">
                  10 characters at least
                </span>
              </div>
            </div>
          ) : settling ? (
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
              {charge.status === "agreed" && !(charge.link && charge.link.status !== "expired" && charge.link.status !== "cancelled") ? (
                <Button size="sm" disabled={pending} onClick={sendLink}>
                  {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
                  Send payment link
                </Button>
              ) : null}
              {charge.status === "agreed" && charge.link?.payUrl && charge.link.status !== "paid" ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={charge.link.payUrl} target="_blank" rel="noopener noreferrer">
                    Open link
                  </a>
                </Button>
              ) : null}
              {charge.status === "agreed" ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setSettling(true)}>
                  Payment received
                </Button>
              ) : null}
              {charge.status !== "void" ? (
                <Button ref={voidTrigger} size="sm" variant="ghost" disabled={pending} onClick={() => setVoiding(true)}>
                  Void…
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min="1"
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

      {/* A void stays on its placement as a receipt, not only in the audit
          log: "unbilled" alone read as if nothing had ever been billed. */}
      {placement.voided.map((v) => (
        <p
          key={v.id}
          className="flex flex-wrap gap-x-2.5 gap-y-0.5 border-l-2 border-border-strong pl-2.5 text-[0.8125rem] text-muted-foreground"
        >
          <s className="font-bold text-faint-foreground">{money(v.amountMinor, v.currency)}</s>
          <span>
            <span className="font-bold text-destructive">voided</span> from {v.fromStatus}
          </span>
          {v.externalRef ? <span>ref {v.externalRef}</span> : null}
          {v.reason ? <span className="min-w-0 break-words">“{v.reason}”</span> : null}
          <span>
            {/* A void from before reasons were kept has no voider either. */}
            {v.reason ? (v.voidedByName ?? "someone since deleted") : "before reasons were recorded"}
            {v.voidedAt ? ` · ${formatDay(v.voidedAt.toISOString())}` : ""}
          </span>
        </p>
      ))}
    </div>
  )
}
