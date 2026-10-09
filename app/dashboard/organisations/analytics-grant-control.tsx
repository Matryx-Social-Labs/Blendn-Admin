"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { endAnalyticsGrant, grantAnalytics } from "@/lib/billing-actions"
import { refusalMessage } from "@/lib/refusal"

/**
 * Give an organisation Analytics without charging it: the founding grant is
 * six months (plan v2 §9.1b). Shaped after `OrgSponsorControl`, because both
 * hand a paid capability over and must record why.
 *
 * The confirm states the end date before anything is pressed. A paid
 * subscription is Razorpay's to end, so this control only ever ends a grant.
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const MONTHS = [6, 3, 12] as const

function endsAfter(months: number): string {
  const end = new Date()
  end.setUTCMonth(end.getUTCMonth() + months)
  return DAY.format(end)
}

export function OrgAnalyticsGrantControl({
  orgId,
  name,
  status,
  analytics,
}: {
  orgId: string
  name: string
  status: string
  analytics: { id: string; source: string; expiresAt: string | null } | null
}) {
  const [confirming, setConfirming] = useState(false)
  const [months, setMonths] = useState<number>(6)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  const until = analytics?.expiresAt ? DAY.format(new Date(analytics.expiresAt)) : null

  function run(work: () => Promise<unknown>, done: string) {
    start(async () => {
      try {
        await work()
        toast.success(done)
        setConfirming(false)
        setReason("")
      } catch (err) {
        toast.error(refusalMessage(err, "Could not change Analytics"))
      }
    })
  }

  // Paid: nothing for an admin to do here, and saying so beats a disabled button.
  if (analytics && analytics.source !== "grant") {
    return (
      <p className="self-start text-[0.8125rem] text-muted-foreground">
        Analytics, paid{until ? ` until ${until}` : ""}
      </p>
    )
  }

  if (status === "suspended" && !analytics) return null

  if (!confirming) {
    return analytics ? (
      <div className="flex items-center gap-2 self-start text-[0.8125rem] text-muted-foreground">
        <span>Analytics, granted{until ? ` until ${until}` : ""}</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          End grant
        </Button>
      </div>
    ) : (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setConfirming(true)}>
        Grant Analytics
      </Button>
    )
  }

  const granting = !analytics
  return (
    <div className="flex max-w-prose flex-col gap-2 border-l-2 border-border-strong pl-3">
      <p className="text-[0.8125rem] leading-6">
        {granting ? (
          <>
            {name} gets <strong>Analytics until {endsAfter(months)}</strong> ({months} months), at no charge. Record why.
          </>
        ) : (
          <>
            {name} loses Analytics <strong>now</strong>, not on {until ?? "its end date"}. Why?
          </>
        )}
      </p>
      {granting ? (
        <label className="flex w-fit flex-col gap-1 text-[0.75rem] text-muted-foreground">
          Length
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 text-[0.8125rem] text-foreground"
          >
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m} months{m === 6 ? " (founding)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Textarea
        aria-label={granting ? "Why this organisation gets Analytics" : "Why the grant ends"}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        className="rounded-lg"
        placeholder={granting ? "Founding organiser, Bengaluru season one" : "Granted to the wrong organisation"}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={granting ? "default" : "destructive"}
          disabled={pending || reason.trim().length < 10}
          onClick={() =>
            granting
              ? run(() => grantAnalytics(orgId, months, reason), `${name} has Analytics until ${endsAfter(months)}`)
              : run(() => endAnalyticsGrant(orgId, analytics.id, reason), `${name}'s Analytics grant has ended`)
          }
        >
          {granting ? "Grant" : "End grant"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
