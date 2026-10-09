"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { endAnalyticsGrant, grantAnalytics, revokePaidEntitlement } from "@/lib/billing-actions"
import { refusalMessage } from "@/lib/refusal"

/**
 * Give an organisation Analytics without charging it: the founding grant is
 * six months (plan v2 §9.1b). Shaped after `OrgSponsorControl`, because both
 * hand a paid capability over and must record why.
 *
 * A grant and a paid row are shown apart, so a longer paid row never hides a
 * grant an admin needs to end. Ending a grant ends every live grant on the
 * organisation. A paid row can be revoked (a refund made outside Razorpay, a
 * mistake); cancelling at Razorpay is done in Razorpay's dashboard.
 *
 * The confirmation names the end date the server returned, not one this
 * browser's clock worked out.
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const MONTHS = [6, 3, 12] as const
type Mode = null | "grant" | "end" | "revoke"

export function OrgAnalyticsGrantControl({
  orgId,
  name,
  status,
  grant,
  paid,
}: {
  orgId: string
  name: string
  status: string
  grant: { expiresAt: string | null } | null
  paid: { id: string; expiresAt: string | null } | null
}) {
  const [mode, setMode] = useState<Mode>(null)
  const [months, setMonths] = useState<number>(6)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()
  const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null)

  function run(work: () => Promise<string>) {
    start(async () => {
      try {
        toast.success(await work())
        setMode(null)
        setReason("")
      } catch (err) {
        toast.error(refusalMessage(err, "Could not change Analytics"))
      }
    })
  }

  if (mode === null) {
    if (status === "suspended" && !grant && !paid) return null
    return (
      <div className="flex flex-col items-start gap-1 self-start text-[0.8125rem] text-muted-foreground @3xl/main:items-end">
        {paid ? (
          <span className="flex items-center gap-2">
            Analytics, paid{paid.expiresAt ? ` (row ends ${day(paid.expiresAt)})` : ""}
            <Button size="sm" variant="ghost" onClick={() => setMode("revoke")}>
              Revoke
            </Button>
          </span>
        ) : null}
        {grant ? (
          <span className="flex items-center gap-2">
            Analytics, granted{grant.expiresAt ? ` until ${day(grant.expiresAt)}` : ""}
            <Button size="sm" variant="ghost" onClick={() => setMode("end")}>
              End grant
            </Button>
          </span>
        ) : status !== "suspended" ? (
          <Button size="sm" variant="ghost" onClick={() => setMode("grant")}>
            Grant Analytics
          </Button>
        ) : null}
      </div>
    )
  }

  const sentence =
    mode === "grant" ? (
      <>
        {name} gets <strong>Analytics for {months} months</strong>, at no charge. Record why.
      </>
    ) : mode === "end" ? (
      <>
        {name} loses its Analytics grant <strong>now</strong>. Why?
      </>
    ) : (
      <>
        {name} loses its <strong>paid</strong> Analytics now. This does not cancel or refund anything at Razorpay. Why?
      </>
    )

  return (
    <div className="flex max-w-prose flex-col gap-2 border-l-2 border-border-strong pl-3">
      <p className="text-[0.8125rem] leading-6">{sentence}</p>
      {mode === "grant" ? (
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
        aria-label={mode === "grant" ? "Why this organisation gets Analytics" : "Why it ends"}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="rounded-lg"
        placeholder={mode === "grant" ? "Founding organiser, Bengaluru season one" : "Granted to the wrong organisation"}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={mode === "grant" ? "default" : "destructive"}
          disabled={pending || reason.trim().length < 10}
          onClick={() =>
            run(async () => {
              if (mode === "grant") {
                const { expiresAt } = await grantAnalytics(orgId, months, reason)
                return `${name} has Analytics until ${day(expiresAt)}`
              }
              if (mode === "end") {
                await endAnalyticsGrant(orgId, reason)
                return `${name}'s Analytics grant has ended`
              }
              await revokePaidEntitlement(orgId, paid!.id, reason)
              return `${name}'s paid Analytics has been revoked`
            })
          }
        >
          {mode === "grant" ? "Grant" : mode === "end" ? "End grant" : "Revoke"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode(null)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
