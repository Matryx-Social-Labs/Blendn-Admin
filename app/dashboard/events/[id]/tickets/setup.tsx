"use client"

import { useId, useState } from "react"
import { IconCheck, IconExternalLink, IconLoader2 } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { formatBps, formatMinor } from "@/lib/money"
import { cn } from "@/lib/utils"

import { connectPayoutAccount, reviewPayoutAccountFor, turnOnTicketSelling } from "./actions"
import { useTicketAction } from "./use-action"

/**
 * The Tickets tab before it sells (SCRUM-1014): payouts first, then fees, who
 * pays them, the refund policy and the terms (mockup states 1 and 2). Steps
 * after the payout account stay visible, dimmed, until it is verified, so
 * nobody is surprised later.
 */

export function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      aria-label={done ? "Done" : undefined}
      className={cn(
        "flex size-[26px] shrink-0 items-center justify-center rounded-full border border-border-strong text-[0.8125rem] font-bold",
        done && "border-success bg-success text-primary-foreground"
      )}
    >
      {done ? <IconCheck aria-hidden className="size-4" /> : n}
    </span>
  )
}

export function DimStep({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex gap-3.5 opacity-45" aria-disabled="true">
      <StepNumber n={n} />
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="mt-0.5 text-[0.9375rem] font-bold">{title}</h3>
        {hint ? <p className="text-[0.75rem] text-faint-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}

export interface PayoutStepProps {
  eventId: string
  orgName: string
  status: "not_started" | "pending" | "active" | "rejected"
  linkedAccountId: string | null
  submittedOn: string | null
  mayConnect: boolean
  isAdmin: boolean
  owners: string[]
}

/** Step 1. v1 takes the Razorpay linked account id; hosted KYC onboarding is Razorpay's, later. */
export function PayoutStep(p: PayoutStepProps) {
  const fieldId = useId()
  const [account, setAccount] = useState("")
  const { pending, run } = useTicketAction()

  if (p.status === "active") {
    return (
      <div className="flex gap-3.5">
        <StepNumber n={1} done />
        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="mt-0.5 text-[0.9375rem] font-bold">Payout account</h3>
            <p className="text-sm text-muted-foreground">
              Razorpay linked account <span className="font-mono text-[0.8125rem]">{p.linkedAccountId}</span> · verified by Razorpay
            </p>
          </div>
          <span className="text-[0.8125rem] font-medium text-success">Verified</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3.5">
      <StepNumber n={1} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h3 className="mt-0.5 text-[0.9375rem] font-bold">Payout account</h3>
        {p.status === "pending" ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[0.8125rem] font-medium text-warning">Razorpay is checking</span>
              <span className="text-[0.8125rem] text-muted-foreground">
                {p.submittedOn ? `Sent ${p.submittedOn}. ` : ""}Usually 1–2 working days. Account{" "}
                <span className="font-mono">{p.linkedAccountId}</span>.
              </span>
            </div>
            {p.isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={pending} onClick={() => run(() => reviewPayoutAccountFor(p.eventId, "active"))}>
                  Mark verified
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reviewPayoutAccountFor(p.eventId, "rejected"))}>
                  Mark rejected
                </Button>
                <span className="text-[0.75rem] text-faint-foreground">Blend’n admins only. Verified asks Razorpay first.</span>
              </div>
            ) : null}
          </>
        ) : p.mayConnect ? (
          <>
            <p className="max-w-[680px] text-sm text-muted-foreground">
              Ticket money goes to {p.orgName}’s Razorpay account. Create a Route linked account with Razorpay (they check your PAN and bank account,
              usually in 1–2 working days), then enter its id here. You connect once; every event uses it.
            </p>
            {p.status === "rejected" ? <p className="text-[0.8125rem] font-medium text-destructive">Razorpay rejected the last account. Enter a new one.</p> : null}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                run(() => connectPayoutAccount(p.eventId, account), () => setAccount(""))
              }}
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={fieldId} className="text-[0.8125rem] font-medium text-muted-foreground">
                  Razorpay linked account id
                </label>
                <Input
                  id={fieldId}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="acc_XXXXXXXXXXXXXX"
                  className="w-[260px] max-w-full font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={18}
                  pattern="acc_[A-Za-z0-9]{14}"
                  title="acc_ followed by 14 letters and numbers"
                  required
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
                Connect payouts
              </Button>
              <span className="pb-2 text-[0.8125rem] text-faint-foreground">{p.status === "rejected" ? "Rejected" : "Not connected"}</span>
            </form>
          </>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">
            Only an owner or admin of {p.orgName} can connect it.{p.owners.length ? ` Owners: ${p.owners.join(", ")}.` : ""}
          </p>
        )}
      </div>
    </div>
  )
}

export interface TurnOnProps {
  eventId: string
  orgName: string
  currency: string
  rule: "standard" | "pro" | "founding"
  foundingUsed: number
  foundingOfferEvents: number
  foundingEnds: string
  slabs: Array<{ fromTicket: number; toTicket: number | null; bps: number; standardBps: number }>
  minFeeMinor: number
  taxLabel: string
  taxBps: number
  processingBps: number
  exampleMinor: number
  exampleBookingFeeMinor: number
  termsBody: string
  termsSha256: string
  termsVersion: string
  termsDate: string
  accepted: { by: string; on: string; version: string } | null
  mayAccept: boolean
  owners: string[]
  refundPolicy: string
  feesAbsorbed: boolean
}

const POLICIES = [
  { value: "none", label: "No refunds" },
  { value: "until_7d", label: "Until 7 days before" },
  { value: "until_24h", label: "Until 24 hours before" },
] as const

/** Steps 2–4: one form, because one click accepts the terms and turns selling on with these choices. */
export function TurnOnForm(p: TurnOnProps) {
  const termsId = useId()
  const [absorbed, setAbsorbed] = useState(p.feesAbsorbed)
  const [policy, setPolicy] = useState(p.refundPolicy)
  const [ticked, setTicked] = useState(false)
  const { pending, run } = useTicketAction()
  const money = (m: number) => formatMinor(m, p.currency)
  const mayGo = p.accepted ? true : p.mayAccept && ticked

  const ruleLine =
    p.rule === "founding"
      ? `Founding offer, ${p.foundingUsed + 1} of your first ${p.foundingOfferEvents} ticketed events, until ${p.foundingEnds}.`
      : p.rule === "pro"
        ? "Analytics plan: one slab lower."
        : null

  return (
    <div className="grid grid-cols-1 gap-7 @3xl/main:grid-cols-2">
      <div className="flex gap-3.5">
        <StepNumber n={2} />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <h3 className="mt-0.5 text-[0.9375rem] font-bold">Fees and who pays them</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[0.75rem] font-medium text-faint-foreground">
                <th className="py-2 pr-3 font-medium">Tickets sold for this event</th>
                <th className="py-2 text-right font-medium">Blend’n service fee</th>
              </tr>
            </thead>
            <tbody>
              {p.slabs.map((s) => (
                <tr key={s.fromTicket} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-3">{s.toTicket ? `${s.fromTicket}–${s.toTicket}` : `${s.fromTicket} and up`}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {s.bps !== s.standardBps ? (
                      <>
                        <s className="text-faint-foreground">{formatBps(s.standardBps)}</s> {formatBps(s.bps)}
                      </>
                    ) : (
                      formatBps(s.bps)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[0.8125rem] text-faint-foreground">
            {ruleLine ? `${ruleLine} ` : ""}Minimum {money(p.minFeeMinor)} per paid ticket, plus {p.taxLabel} {formatBps(p.taxBps)} on our fee and payment processing at cost
            (about {formatBps(p.processingBps)}). These rates stay with this event once it sells.
          </p>
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-2 text-[0.8125rem] text-faint-foreground">Who pays the booking fee</legend>
            <Choice name={`${termsId}-fee`} checked={!absorbed} onChange={() => setAbsorbed(false)} label="Buyers pay it">
              A {money(p.exampleMinor)} ticket costs the buyer {formatMinor(p.exampleMinor + p.exampleBookingFeeMinor, p.currency, { paise: true })}. You get {money(p.exampleMinor)}.
            </Choice>
            <Choice name={`${termsId}-fee`} checked={absorbed} onChange={() => setAbsorbed(true)} label="We absorb it">
              Buyers pay {money(p.exampleMinor)}. The fee comes out of your payout.
            </Choice>
          </fieldset>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex gap-3.5">
          <StepNumber n={3} />
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <h3 className="mt-0.5 text-[0.9375rem] font-bold" id={`${termsId}-rp`}>
              Refund policy
            </h3>
            <div role="radiogroup" aria-labelledby={`${termsId}-rp`} className="flex flex-wrap gap-2">
              {POLICIES.map((o) => (
                <label key={o.value} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border-strong px-3 py-2 text-sm pointer-coarse:min-h-11">
                  <input type="radio" name={`${termsId}-policy`} value={o.value} checked={policy === o.value} onChange={() => setPolicy(o.value)} className="accent-primary" />
                  {o.label}
                </label>
              ))}
            </div>
            <p className="text-[0.8125rem] text-faint-foreground">Buyers see it before they pay. If you cancel the event, every buyer gets everything back, booking fee included.</p>
          </div>
        </div>

        <div className="flex gap-3.5">
          <StepNumber n={4} />
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <h3 className="mt-0.5 text-[0.9375rem] font-bold">Organizer Ticketing Terms</h3>
            <div
              tabIndex={0}
              role="region"
              aria-label={`Organizer Ticketing Terms, version ${p.termsVersion}`}
              className="terms-panel h-[200px] overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] px-3.5 py-3 text-[0.8125rem] leading-[1.55] text-muted-foreground"
              // Our own committed file (docs/legal/organizer-ticketing-terms.html), never user input.
              dangerouslySetInnerHTML={{ __html: p.termsBody }}
            />
            <div className="flex flex-wrap justify-between gap-2 text-[0.8125rem] text-muted-foreground">
              <span>
                Scroll to read, or{" "}
                <a className="font-medium text-foreground underline underline-offset-[3px]" href="/terms/organizer-tickets" target="_blank" rel="noopener">
                  open the full terms
                  <IconExternalLink aria-hidden className="ml-0.5 inline size-3.5" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                in a new tab.
              </span>
              <span className="text-faint-foreground">
                Version {p.termsVersion} · {p.termsDate}
              </span>
            </div>
            {p.accepted ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                Accepted by {p.accepted.by} on {p.accepted.on} · v{p.accepted.version}
              </p>
            ) : p.mayAccept ? (
              <div className="flex items-start gap-2.5 text-sm">
                <Checkbox id={`${termsId}-accept`} checked={ticked} onCheckedChange={(v) => setTicked(v === true)} className="mt-0.5" />
                <label htmlFor={`${termsId}-accept`} className="cursor-pointer">
                  I have read and accept the Organizer Ticketing Terms on behalf of <b>{p.orgName}</b>.
                </label>
              </div>
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">
                Only an owner or admin of {p.orgName} can accept the terms.{p.owners.length ? ` Owners: ${p.owners.join(", ")}.` : ""}
              </p>
            )}
            {p.accepted || p.mayAccept ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  aria-disabled={!mayGo || pending}
                  onClick={() => {
                    if (!mayGo || pending) return
                    run(() => turnOnTicketSelling(p.eventId, { documentSha256: p.termsSha256, refundPolicy: policy, feesAbsorbed: absorbed }))
                  }}
                >
                  {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
                  {p.accepted ? "Turn on ticket selling" : "Accept and turn on ticket selling"}
                </Button>
                {!mayGo ? <span className="text-[0.8125rem] text-faint-foreground">Tick the box to continue.</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function Choice({ name, checked, onChange, label, children }: { name: string; checked: boolean; onChange: () => void; label: string; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-[3px] size-4 shrink-0 accent-primary" />
      <span>
        {label}
        <small className="block text-[0.8125rem] text-muted-foreground">{children}</small>
      </span>
    </label>
  )
}
