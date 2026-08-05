"use client"

import { useState, useTransition } from "react"
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconMailQuestion,
  IconX,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { approveOnboardingRequest, declineOnboardingRequest, type OnboardingRow } from "@/lib/onboarding-actions"

/**
 * The review queue.
 *
 * Expanded inline rather than in a modal: the reviewer is comparing several
 * applications and a dialog forces them to close one to look at the next.
 *
 * The generated password is shown once, after approval, and only when email did
 * not go out — if the applicant already received it, echoing it on screen is a
 * credential sitting in a browser tab for no reason.
 */
export function OnboardingQueue({ rows }: { rows: OnboardingRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </div>
  )
}

function Row({ row }: { row: OnboardingRow }) {
  const [open, setOpen] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState("")
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null)
  const [pending, start] = useTransition()

  const awaitingEmail = row.status === "email_pending"

  function approve() {
    start(async () => {
      try {
        const result = await approveOnboardingRequest(row.id)
        if (result.emailSent) {
          toast.success(`${row.display_name} approved — sign-in details emailed.`)
        } else {
          toast.success(`${row.display_name} approved.`)
          if (result.password) setCredential({ email: result.email, password: result.password })
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not approve")
      }
    })
  }

  function decline() {
    start(async () => {
      try {
        await declineOnboardingRequest(row.id, reason)
        toast.success("Declined — the applicant has been told why.")
        setDeclining(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not decline")
      }
    })
  }

  if (credential) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-5">
        <h3 className="font-semibold">{row.display_name} approved</h3>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          Email is not configured, so nothing was sent. Pass these on yourself — this is the only
          time the password is shown.
        </p>
        <dl className="grid gap-1 rounded-lg border border-border bg-card p-4 font-mono text-[0.8125rem]">
          <div className="flex gap-3">
            <dt className="w-20 text-muted-foreground">Email</dt>
            <dd>{credential.email}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-20 text-muted-foreground">Password</dt>
            <dd className="select-all">{credential.password}</dd>
          </div>
        </dl>
        <Button variant="outline" size="sm" className="self-start" onClick={() => setCredential(null)}>
          Done
        </Button>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex flex-wrap items-baseline justify-between gap-3 text-left"
      >
        <div className="flex flex-col gap-1">
          <span className="font-semibold">{row.display_name}</span>
          <span className="text-[0.8125rem] text-muted-foreground">
            {row.contact_name} · {row.contact_email}
            {row.city ? ` · ${row.city}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {row.requested_role === "venue_owner" ? "Venue owner" : "Organiser"}
          </Badge>
          {awaitingEmail ? (
            <Badge variant="outline" className="gap-1">
              <IconMailQuestion className="size-3.5" /> Email unconfirmed
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <IconCircleCheck className="size-3.5" /> Email confirmed
            </Badge>
          )}
          <Badge variant={row.freeProvider ? "outline" : "default"}>
            {row.freeProvider ? "Personal email" : row.emailDomain}
          </Badge>
        </div>
      </button>

      {open ? (
        <dl className="grid gap-2 border-t border-border pt-3 text-[0.8125rem] @2xl/main:grid-cols-2">
          <Detail label="Legal name" value={row.legal_name} />
          <Detail label="Kind" value={row.kind} />
          <Detail label="Website" value={row.website} />
          <Detail label="Phone" value={row.contact_phone} />
          <Detail label="Address" value={row.address} />
          <Detail label="Applied" value={row.created_at.toLocaleDateString()} />
          {row.gstin ? (
            <div className="flex flex-col gap-0.5 @2xl/main:col-span-2">
              <dt className="text-muted-foreground">GSTIN</dt>
              <dd className="font-mono">{row.gstin}</dd>
              <dd className="text-muted-foreground">{row.gstinCheck}</dd>
            </div>
          ) : null}
          {row.relatedCount > 0 ? (
            <p className="flex items-start gap-2 text-destructive @2xl/main:col-span-2">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              {row.relatedCount} other application{row.relatedCount > 1 ? "s" : ""} from this email
              address.
            </p>
          ) : null}
        </dl>
      ) : null}

      {awaitingEmail ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          They haven&apos;t clicked the confirmation link yet. You can still approve — it just means
          the address is unproven.
        </p>
      ) : null}

      {declining ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why? This is emailed to the applicant, so make it useful."
            className="rounded-lg"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={decline} disabled={pending || reason.trim().length < 10}>
              Send decline
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeclining(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={approve} disabled={pending}>
            <IconCheck className="size-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDeclining(true)} disabled={pending}>
            <IconX className="size-4" /> Decline
          </Button>
        </div>
      )}
    </section>
  )
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
