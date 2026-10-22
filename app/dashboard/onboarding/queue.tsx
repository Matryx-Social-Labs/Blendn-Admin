"use client"

import { useId, useState, useTransition } from "react"
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheck,
  IconMailQuestion,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { evidenceMarks, type EvidenceIcon, type EvidenceWeight } from "@/lib/application-evidence"
import { queueAgeLabel, queueBreached } from "@/lib/attention-queues"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DecideBox } from "@/components/dashboard/decide-box"
import { Facts, Panel } from "@/components/dashboard/kit"
import { approveOnboardingRequest, declineOnboardingRequest, type OnboardingRow } from "@/lib/onboarding-actions"
import { refusalMessage } from "@/lib/refusal"

/**
 * The review queue.
 *
 * Expanded inline rather than in a modal: the reviewer is comparing several
 * applications and a dialog forces them to close one to look at the next.
 *
 * The set-password link is shown once, after approval, and only when email did
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

/** The presentation half of `evidenceMarks` — names in, nodes out. */
const EVIDENCE_ICON: Record<EvidenceIcon, React.ReactNode> = {
  "alert-triangle": <IconAlertTriangle aria-hidden className="size-3.5" />,
  "mail-question": <IconMailQuestion aria-hidden className="size-3.5" />,
  "circle-check": <IconCircleCheck aria-hidden className="size-3.5" />,
}

/**
 * Every mark is an outlined chip; its weight is its colour. A reason to refuse
 * is red, a credential green, context muted — so the two extremes never share
 * a register, which is the mistake this queue once made (a filled badge for
 * both the applicant's own domain and a ticketing platform's).
 */
const WEIGHT_TONE: Record<EvidenceWeight, string> = {
  against: "border-destructive/45 text-destructive",
  for: "border-success/45 text-success",
  state: "border-border-strong text-muted-foreground",
  neutral: "border-border-strong text-muted-foreground",
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
  /*
   * Held HERE, not in the row. `approveOnboardingRequest` revalidates this
   * path, so the approved row leaves the list in the same round trip that
   * produced the link — and a row that has unmounted cannot show anything.
   * Driven locally with email unconfigured: the toast said "approved", the
   * badge went 7 → 6, and the one-time credential the copy promises was on
   * screen for zero frames. It has to outlive the row it came from.
   */
  const [credential, setCredential] = useState<Credential | null>(null)
  return (
    <div className="flex flex-col gap-3">
      {credential ? <CredentialPanel credential={credential} onDone={() => setCredential(null)} /> : null}
      {rows.map((row) => (
        <Row key={row.id} row={row} now={now} onCredential={setCredential} />
      ))}
    </div>
  )
}

type Credential = { name: string; email: string; setPasswordLink: string }

function CredentialPanel({ credential, onDone }: { credential: Credential; onDone: () => void }) {
  return (
    <section role="status" className="flex flex-col gap-3 rounded-panel border border-primary/40 bg-primary/5 p-5">
      <h2 className="text-panel-title font-bold">{credential.name} approved</h2>
      <p className="text-[0.8125rem] leading-6 text-muted-foreground">
        Email is not configured, so nothing was sent. Pass this link on yourself — it works once,
        expires in 24 hours, and this is the only time it is shown.
      </p>
      <dl className="grid gap-1 border-t border-border pt-3 font-mono text-[0.8125rem]">
        <div className="flex gap-3">
          <dt className="w-20 text-muted-foreground">Email</dt>
          <dd>{credential.email}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 text-muted-foreground">Link</dt>
          <dd className="select-all break-all">{credential.setPasswordLink}</dd>
        </div>
      </dl>
      <Button variant="outline" size="sm" className="self-start" onClick={onDone}>
        Done
      </Button>
    </section>
  )
}

function Row({
  row,
  now,
  onCredential,
}: {
  row: OnboardingRow
  now: Date
  onCredential: (c: Credential) => void
}) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
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
          if (result.setPasswordLink)
            onCredential({ name: row.display_name, email: result.email, setPasswordLink: result.setPasswordLink })
        }
      } catch (err) {
        toast.error(refusalMessage(err, "Could not approve"))
      }
    })
  }

  function decline(reason: string) {
    start(async () => {
      try {
        await declineOnboardingRequest(row.id, reason)
        toast.success("Declined — the applicant has been told why.")
      } catch (err) {
        toast.error(refusalMessage(err, "Could not decline"))
      }
    })
  }

  return (
    <Panel>
      {/* The accordion pattern: the heading holds the button, so the row is
          reachable by heading and by tab, and says whether it is open. */}
      <h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          // Only while the panel is mounted; an id that points at nothing is worse
          // than no relationship.
          aria-controls={open ? detailId : undefined}
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[0.9375rem] font-bold">{row.display_name}</span>
            <span className="text-[0.8125rem] font-normal text-muted-foreground">
              {row.contact_name} · {row.contact_email}
              {row.city ? ` · ${row.city}` : ""}
            </span>
          </span>
          {/*
            Evidence on a signed axis, heaviest mark first.

            The badges were rendered in a fixed sequence — role, email state,
            domain — so the strongest mark on a row could sit third. That
            defeats the thing the marks are for: an admin scanning seven rows
            should be able to read the LEFT EDGE of this column and know which
            row needs reading, before reading a word.

            `evidenceMarks` sorts by weight, and each weight has its own colour
            on an outlined chip (`WEIGHT_TONE`). Found by building the screen in
            HTML first — the colour fix alone left the aggregator warning third
            in a fixed order, which looked correct in isolation and wrong in a
            column.
          */}
          <span className="flex flex-wrap items-center gap-2 font-normal">
            {evidenceMarks(
              {
                roleLabel: ROLE_LABEL[row.requested_role],
                emailDomain: row.emailDomain,
                freeProvider: row.freeProvider,
                aggregatorDomain: row.aggregatorDomain,
              },
              awaitingEmail
            ).map((mark) => (
              <span
                key={mark.key}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[0.75rem] font-medium",
                  WEIGHT_TONE[mark.weight]
                )}
              >
                {mark.icon ? EVIDENCE_ICON[mark.icon] : null}
                {mark.label}
              </span>
            ))}
            {/*
              The age, on the collapsed row, against the same 72-hour window the
              attention strip uses — so the two cannot disagree about what late
              means.
            */}
            {age ? (
              <span
                className={cn(
                  "text-[0.8125rem] tabular-nums",
                  breached ? "font-bold text-destructive" : "text-muted-foreground"
                )}
              >
                {age}
              </span>
            ) : null}
            <IconChevronDown
              aria-hidden
              className={cn("size-4 text-faint-foreground transition-transform", open && "rotate-180")}
            />
          </span>
        </button>
      </h2>

      {open ? (
        <div id={detailId} className="flex flex-col gap-3 border-t border-border pt-3.5">
          {/*
            Evidence only. `Kind`, `Phone` and `Address` were here and none of
            them changes a decision — an admin does not approve or refuse an
            application on the strength of a phone number. Legal name, website
            and GSTIN are what the gate actually weighs, so they are what is
            left.
          */}
          <Facts
            items={[
              { label: "Legal name", value: row.legal_name },
              { label: "Website", value: row.website },
              row.gstin
                ? {
                    label: "GSTIN",
                    value: (
                      <>
                        <span className="font-mono">{row.gstin}</span>
                        <span className="block text-muted-foreground">{row.gstinCheck}</span>
                      </>
                    ),
                  }
                : null,
            ]}
          />
          {row.relatedCount > 0 ? (
            <p className="flex items-start gap-2 text-[0.8125rem] text-destructive">
              <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {row.relatedCount} other application{row.relatedCount > 1 ? "s" : ""} from this email address.
            </p>
          ) : null}
        </div>
      ) : null}

      {awaitingEmail ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          They haven&apos;t clicked the confirmation link yet. You can still approve — it just means the address is
          unproven.
        </p>
      ) : null}

      {/*
        Approve is the near-irreversible one, and it was the filled brand
        button on all seven rows.

        It creates an organisation, a user and a membership in one transaction,
        and hands over publishing and the attendee list. Seven of them at full
        saturation made the consequential action the screen's background — the
        same inversion as the events list, where `published` was a filled pill
        on fifteen of seventeen rows.

        Both actions are outline, because on this screen neither is the
        default: the whole point is that a person weighs the evidence first.
        The consequence is named on the button rather than left implicit.
      */}
      <DecideBox
        outlineApprove
        approveLabel="Approve & create the account"
        sendLabel="Send decline"
        reasonLabel={`Why ${row.display_name}'s application is declined`}
        placeholder="Why? This is emailed to the applicant, so make it useful."
        pending={pending}
        onApprove={approve}
        onDecline={decline}
      />
    </Panel>
  )
}
