"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  IconAlertTriangle,
  IconBuildingStore,
  IconExternalLink,
  IconFileText,
  IconLoader2,
} from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/dashboard/primitives"
import { decideSponsorClaim, type SponsorClaimQueueRow } from "@/lib/sponsor-claim-actions"
import { formatDay } from "@/lib/dashboard-format"

const DOC_LABELS: Record<string, string> = {
  authorisation: "Authorisation letter",
  incorporation: "Incorporation",
  other: "Other",
}

/**
 * The brand claim queue.
 *
 * Same shape as `venue-claim-queue`, because it is the same decision: grant
 * ownership on evidence nothing can check automatically. Flags are derived at
 * read time and shown as things to weigh, not as a score — except the
 * already-owns-a-brand flag, which genuinely blocks approval, so the button says
 * so instead of letting the click fail.
 */
export function SponsorClaimQueue({ claims }: { claims: SponsorClaimQueueRow[] }) {
  if (claims.length === 0) {
    return (
      <EmptyState
        icon={<IconBuildingStore />}
        title="No claims waiting"
        description="Organisers add brands free-hand while setting up an event. A company claims one to take over its name, logo and reporting — that lands here rather than applying itself."
      />
    )
  }

  return (
    <div className="flex flex-col divide-y divide-border border-t border-border">
      {claims.map((claim) => (
        <ClaimCard key={claim.id} claim={claim} />
      ))}
    </div>
  )
}

function ClaimCard({ claim }: { claim: SponsorClaimQueueRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState("")
  const [rejecting, setRejecting] = useState(false)

  function decide(decision: "approve" | "reject") {
    startTransition(async () => {
      try {
        await decideSponsorClaim(claim.id, decision, note)
        toast.success(
          decision === "approve"
            ? `${claim.orgName} now owns ${claim.brandName}.`
            : "Claim rejected — the reason goes to the claimant."
        )
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not record the decision.")
      }
    })
  }

  const docs = Object.entries(claim.evidence).filter(([, url]) => !!url)
  // Named in the flag by `getSponsorClaimQueue`, and refused by
  // `decideSponsorClaim`. Disabling here means the reviewer reads it before
  // clicking rather than after.
  const blocked = claim.flags.some((f) => f.includes("merge instead"))

  return (
    <section className="flex flex-col gap-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.9375rem] font-bold">{claim.brandName}</span>
            {claim.isDispute ? <Badge variant="destructive">Dispute</Badge> : null}
            {claim.placements > 0 ? (
              <Badge variant="secondary">
                {claim.placements} placement{claim.placements === 1 ? "" : "s"} transfer
              </Badge>
            ) : null}
          </div>
          <p className="text-[0.78125rem] text-muted-foreground">
            {claim.brandWebsite ?? "No website on the brand"}
          </p>
        </div>
        <p className="text-[0.75rem] text-faint-foreground">
          Filed {formatDay(claim.createdAt.toISOString())}
        </p>
      </div>

      <dl className="grid gap-3 text-[0.8125rem] @2xl/main:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-faint-foreground">Claimed by</dt>
          <dd className="font-medium">
            {claim.orgName}
            {claim.filedByName ? (
              <span className="font-normal text-muted-foreground"> · {claim.filedByName}</span>
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-faint-foreground">GSTIN</dt>
          <dd className="font-mono text-[0.78125rem]">
            {claim.gstin ?? "—"}
            {claim.gstinCheck ? (
              <span className="ml-2 font-sans text-[0.75rem] text-muted-foreground">
                {claim.gstinCheck}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {claim.isDispute && claim.currentOwnerName ? (
        <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 px-3.5 py-3">
          <p className="flex items-center gap-2 text-[0.8125rem] font-bold">
            <IconAlertTriangle className="size-4 text-warning" />
            Currently owned by {claim.currentOwnerName}
          </p>
          <p className="text-[0.78125rem] text-muted-foreground">
            Approving takes the brand — and its reporting on {claim.placements} placement
            {claim.placements === 1 ? "" : "s"} — away from them.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-[0.75rem] font-bold uppercase tracking-wide text-faint-foreground">
          Evidence
        </p>
        {docs.length === 0 ? (
          <p className="text-[0.78125rem] text-muted-foreground">Nothing attached.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {docs.map(([key, url]) => (
              <a
                key={key}
                href={url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-[0.78125rem] hover:bg-surface-raised"
              >
                <IconFileText className="size-3.5" />
                {DOC_LABELS[key] ?? key}
                <IconExternalLink className="size-3 text-faint-foreground" />
              </a>
            ))}
          </div>
        )}
      </div>

      {claim.flags.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {claim.flags.map((flag) => (
            <li
              key={flag}
              className="flex items-center gap-2 text-[0.78125rem] text-muted-foreground"
            >
              <IconAlertTriangle className="size-3.5 shrink-0 text-warning" />
              {flag}
            </li>
          ))}
        </ul>
      ) : null}

      {rejecting ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this was rejected — it is sent to the claimant, and a rejection with no reason produces an identical re-file."
            rows={3}
            autoFocus
          />
          <p className="text-[0.75rem] text-faint-foreground">
            {note.trim().length < 10
              ? `${10 - note.trim().length} more characters needed.`
              : "Ready to send."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {rejecting ? (
          <>
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Back
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || note.trim().length < 10}
              onClick={() => decide("reject")}
            >
              {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
              Send rejection
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button
              type="button"
              disabled={pending || blocked}
              title={blocked ? "This organisation already owns a brand — merge them instead." : undefined}
              onClick={() => decide("approve")}
            >
              {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
              {claim.isDispute ? "Transfer brand" : "Approve claim"}
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
