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

import { queueAgeLabel, queueBreached } from "@/lib/attention-queues"
import { cn } from "@/lib/utils"
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
/**
 * Every role an application can request, labelled.
 *
 * Typed against `OnboardingRow["requested_role"]` so adding a value to the
 * union is a compile error here rather than a wrong label in production.
 */
const ROLE_LABEL: Record<OnboardingRow["requested_role"], string> = {
  organizer: "Organiser",
  venue_owner: "Venue owner",
  sponsor: "Sponsor",
}

export function OnboardingQueue({
  rows,
  generatedAt,
}: {
  rows: OnboardingRow[]
  /**
   * Server time, ISO.
   *
   * The ages are rendered in a client component, so a `new Date()` taken during
   * hydration is a different now from the one the server rendered with — an
   * application sitting at 71h59m crosses the SLA boundary between the two and
   * React reports a mismatch on a screen that was correct both times. Same fix
   * as the overview's `generatedAt`.
   */
  generatedAt: string
}) {
  const now = new Date(generatedAt)
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <Row key={row.id} row={row} now={now} />
      ))}
    </div>
  )
}

function Row({ row, now }: { row: OnboardingRow; now: Date }) {
  const [open, setOpen] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState("")
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null)
  const [pending, start] = useTransition()

  const awaitingEmail = row.status === "email_pending"

  /*
   * The same age rule the attention strip uses, not a second one.
   *
   * `lib/attention-queues.ts` gives applications a 72-hour window and the
   * overview's strip renders "oldest 12 days" from it. This queue showed
   * `Applied` as a bare date inside the collapsed panel, so the SLA was
   * invisible on the screen where the decision is taken. Two answers to "is
   * this late" is the shape this codebase keeps paying for; one function, read
   * twice.
   */
  const queue = { count: 1, oldest: row.created_at.toISOString(), slaHours: 72 }
  const age = queueAgeLabel(queue, now)
  const breached = queueBreached(queue, now)

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
          {/*
            An exhaustive map, not a ternary.

            This read `venue_owner ? "Venue owner" : "Organiser"`, so the moment
            sponsor applications existed they rendered as "Organiser" — an admin
            approving one would grant placement rights believing they were
            approving a host, and nothing on screen would say otherwise.
          */}
          <Badge variant="secondary">{ROLE_LABEL[row.requested_role]}</Badge>
          {awaitingEmail ? (
            <Badge variant="outline" className="gap-1">
              <IconMailQuestion className="size-3.5" /> Email unconfirmed
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <IconCircleCheck className="size-3.5" /> Email confirmed
            </Badge>
          )}
          {/*
            An aggregator domain is a warning, not a credential.

            A company address is accepted as-is precisely because it is evidence
            the applicant belongs to the organisation. That argument inverts at
            a ticketing platform: `bookings@in.bookmyshow.com` proves somebody
            works at BookMyShow, and the events they would be claiming are not
            BookMyShow's. Rendering it in the same filled badge as
            `thehummingtree.com` said the opposite of what it means.
          */}
          {row.aggregatorDomain ? (
            <Badge variant="destructive" className="gap-1">
              <IconAlertTriangle className="size-3.5" />
              Ticketing platform · {row.emailDomain}
            </Badge>
          ) : (
            <Badge variant={row.freeProvider ? "outline" : "default"}>
              {row.freeProvider ? "Personal email" : row.emailDomain}
            </Badge>
          )}
          {/*
            The age, on the collapsed row.

            It was `Applied` inside the expanded panel, as a bare date — so the
            queue's SLA was invisible until you opened a row, and the overview
            could say "oldest 12 days" while this screen said nothing about
            which. Same functions the attention strip uses, so the two cannot
            disagree about what "late" means.
          */}
          {age ? (
            <span
              className={cn(
                "text-[0.75rem] tabular-nums",
                breached ? "font-medium text-destructive" : "text-muted-foreground"
              )}
            >
              {age}
            </span>
          ) : null}
        </div>
      </button>

      {open ? (
        <dl className="grid gap-2 border-t border-border pt-3 text-[0.8125rem] @2xl/main:grid-cols-2">
          {/*
            Evidence only. `Kind`, `Phone` and `Address` were here and none of
            them changes a decision — an admin does not approve or refuse an
            application on the strength of a phone number. Legal name, website
            and GSTIN are what the gate actually weighs, so they are what is
            left.

            `Applied` went too: it was a bare date in a panel you had to open,
            on the one screen where age IS the ordering. It is on the collapsed
            row now, against the same 72-hour window the attention strip uses.
          */}
          <Detail label="Legal name" value={row.legal_name} />
          <Detail label="Website" value={row.website} />
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
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Approve is the near-irreversible one, and it was the filled brand
            button on all seven rows.

            It creates an organisation, a user and a membership in one
            transaction, and hands over publishing and the attendee list. Seven
            of them at full saturation made the consequential action the
            screen's background — the same inversion as the events list, where
            `published` was a filled pill on fifteen of seventeen rows.

            Both actions are outline now, because on this screen neither is the
            default: the whole point is that a person weighs the evidence first.
            The consequence is named on the button rather than left implicit.
          */}
          <Button size="sm" variant="outline" onClick={approve} disabled={pending}>
            <IconCheck className="size-4" /> Approve &amp; create the account
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
