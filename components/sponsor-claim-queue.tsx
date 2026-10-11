"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { IconBuildingStore } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { ClaimFlags, EvidenceDocs, Gstin } from "@/components/claim-evidence"
import { DecideBox } from "@/components/dashboard/decide-box"
import { Callout, Facts, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { decideSponsorClaim, type SponsorClaimQueueRow } from "@/lib/sponsor-claim-actions"
import { formatDay } from "@/lib/dashboard-format"
import { refusalMessage } from "@/lib/refusal"

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
    <div className="flex flex-col gap-3.5">
      {claims.map((claim) => (
        <ClaimCard key={claim.id} claim={claim} />
      ))}
    </div>
  )
}

function ClaimCard({ claim }: { claim: SponsorClaimQueueRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function decide(decision: "approve" | "reject", note?: string) {
    startTransition(async () => {
      try {
        const { notified } = await decideSponsorClaim(claim.id, decision, note)
        toast.success(
          decision === "approve"
            ? `${claim.orgName} now owns ${claim.brandName}.`
            : notified
              ? "Claim rejected — the reason has been emailed to the claimant."
              : "Claim rejected — email is not configured, so nothing was sent. Tell them yourself."
        )
        router.refresh()
      } catch (e) {
        toast.error(refusalMessage(e, "Could not record the decision."))
      }
    })
  }

  const docs = Object.entries(claim.evidence).filter((d): d is [string, string] => !!d[1])
  // Named in the flag by `getSponsorClaimQueue`, and refused by
  // `decideSponsorClaim`. Disabling here means the reviewer reads it before
  // clicking rather than after.
  const blocked = claim.flags.some((f) => f.includes("merge instead"))

  return (
    <Panel>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[0.9375rem] font-bold">{claim.brandName}</h2>
          {claim.isDispute ? <Badge variant="destructive">Dispute</Badge> : null}
          {claim.placements > 0 ? (
            <Badge variant="secondary">
              {claim.placements} placement{claim.placements === 1 ? "" : "s"} transfer
            </Badge>
          ) : null}
          <span className="ml-auto text-[0.75rem] text-faint-foreground">
            Filed {formatDay(claim.createdAt.toISOString())}
          </span>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">{claim.brandWebsite ?? "No website on the brand"}</p>
      </div>

      <Facts
        items={[
          {
            label: "Claimed by",
            value: (
              <>
                <span className="font-medium">{claim.orgName}</span>
                {claim.filedByName ? <span className="text-muted-foreground"> · {claim.filedByName}</span> : null}
              </>
            ),
          },
          { label: "GSTIN", value: claim.gstin ? <Gstin gstin={claim.gstin} check={claim.gstinCheck} /> : null },
        ]}
      />

      {claim.isDispute && claim.currentOwnerName ? (
        <Callout title={`Currently owned by ${claim.currentOwnerName}`}>
          Approving takes the brand — and its reporting on {claim.placements} placement
          {claim.placements === 1 ? "" : "s"} — away from them.
        </Callout>
      ) : null}

      <EvidenceDocs docs={docs} labels={DOC_LABELS} />
      <ClaimFlags flags={claim.flags} />

      <DecideBox
        approveLabel={claim.isDispute ? "Transfer brand" : "Approve claim"}
        declineLabel="Reject"
        sendLabel="Send rejection"
        reasonLabel={`Why the claim on ${claim.brandName} is rejected`}
        placeholder="Why this was rejected — it is sent to the claimant, and a rejection with no reason produces an identical re-file."
        pending={pending}
        approveDisabled={blocked}
        approveTitle={blocked ? "This organisation already owns a brand — merge them instead." : undefined}
        onApprove={() => decide("approve")}
        onDecline={(reason) => decide("reject", reason)}
      />
    </Panel>
  )
}
