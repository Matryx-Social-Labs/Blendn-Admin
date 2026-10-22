"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  endAnalyticsGrant,
  endPlusGrant,
  endVenueProGrant,
  grantAnalytics,
  grantPlus,
  grantVenuePro,
  revokePaidEntitlement,
  revokeVenueProPaid,
} from "@/lib/billing-actions"
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
 *
 * The same control gives a venue Venue Pro (`subject="venue"`, step 17): the
 * founding grant there is three months per claimed Bengaluru venue. And a
 * person Blendn+ (`subject="user"`, SCRUM-583) — the App Review account, a
 * lost Night Pass, goodwill. A person's paid Plus is a store's, so there is no
 * Revoke for it here (`paid` is never passed for a person).
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
type Mode = null | "grant" | "end" | "revoke"

/** What each subject is given, and its founding grant first. */
const PRODUCT = {
  org: { label: "Analytics", months: [6, 3, 12], founding: 6, firstNote: "founding", example: "Founding organiser, Bengaluru season one" },
  venue: { label: "Venue Pro", months: [3, 6, 12], founding: 3, firstNote: "founding", example: "Founding venue, claimed in Bengaluru" },
  user: { label: "Blendn+", months: [1, 3, 12], founding: 1, firstNote: "App Review", example: "App Review account for the iOS submission" },
} as const

export function OrgAnalyticsGrantControl({
  subjectId,
  subject = "org",
  name,
  status,
  grant,
  paid,
  onChanged,
}: {
  /** The organisation's id, the venue's when `subject` is "venue", the person's when "user". */
  subjectId: string
  subject?: "org" | "venue" | "user"
  name: string
  status: string
  grant: { expiresAt: string | null } | null
  paid: { id: string; expiresAt: string | null } | null
  /** Called after a change lands, for a host that loaded the state itself (the Users page's sheet). */
  onChanged?: () => void
}) {
  const product = PRODUCT[subject]
  const [mode, setMode] = useState<Mode>(null)
  const [months, setMonths] = useState<number>(product.founding)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()
  const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null)

  function run(work: () => Promise<string>) {
    start(async () => {
      try {
        toast.success(await work())
        setMode(null)
        setReason("")
        onChanged?.()
      } catch (err) {
        toast.error(refusalMessage(err, `Could not change ${product.label}`))
      }
    })
  }

  if (mode === null) {
    if (status === "suspended" && !grant && !paid) return null
    return (
      <div className="flex flex-col items-start gap-1 self-start text-[0.8125rem] text-muted-foreground @3xl/main:items-end">
        {paid ? (
          <span className="flex items-center gap-2">
            {product.label}, paid{paid.expiresAt ? ` (row ends ${day(paid.expiresAt)})` : ""}
            <Button size="sm" variant="ghost" onClick={() => setMode("revoke")}>
              Revoke
            </Button>
          </span>
        ) : null}
        {grant ? (
          <span className="flex items-center gap-2">
            {product.label}, granted{grant.expiresAt ? ` until ${day(grant.expiresAt)}` : ""}
            <Button size="sm" variant="ghost" onClick={() => setMode("end")}>
              End grant
            </Button>
          </span>
        ) : status !== "suspended" ? (
          <Button size="sm" variant="ghost" onClick={() => setMode("grant")}>
            Grant {product.label}
          </Button>
        ) : null}
      </div>
    )
  }

  const sentence =
    mode === "grant" ? (
      <>
        {name} gets <strong>{product.label} for {months} month{months === 1 ? "" : "s"}</strong>, at no charge. Record why.
      </>
    ) : mode === "end" ? (
      <>
        {name} loses its {product.label} grant <strong>now</strong>. Why?
      </>
    ) : (
      <>
        {name} loses its <strong>paid</strong> {product.label} now. This does not cancel or refund anything at Razorpay. Why?
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
            {product.months.map((m) => (
              <option key={m} value={m}>
                {m} month{m === 1 ? "" : "s"}{m === product.founding ? ` (${product.firstNote})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Textarea
        aria-label={mode === "grant" ? `Why this ${subject === "venue" ? "venue" : subject === "user" ? "person" : "organisation"} gets ${product.label}` : "Why it ends"}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="rounded-lg"
        placeholder={mode === "grant" ? product.example : "Granted to the wrong organisation"}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={mode === "grant" ? "default" : "destructive"}
          disabled={pending || reason.trim().length < 10}
          onClick={() =>
            run(async () => {
              const venue = subject === "venue"
              const person = subject === "user"
              if (mode === "grant") {
                const { expiresAt } = person
                  ? await grantPlus(subjectId, months, reason)
                  : venue
                    ? await grantVenuePro(subjectId, months, reason)
                    : await grantAnalytics(subjectId, months, reason)
                return `${name} has ${product.label} until ${day(expiresAt)}`
              }
              if (mode === "end") {
                await (person ? endPlusGrant(subjectId, reason) : venue ? endVenueProGrant(subjectId, reason) : endAnalyticsGrant(subjectId, reason))
                return `${name}'s ${product.label} grant has ended`
              }
              await (venue ? revokeVenueProPaid(subjectId, paid!.id, reason) : revokePaidEntitlement(subjectId, paid!.id, reason))
              return `${name}'s paid ${product.label} has been revoked`
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
