"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconBuildingStore } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { ClaimFlags, EvidenceDocs, Gstin } from "@/components/claim-evidence"
import { DecideBox } from "@/components/dashboard/decide-box"
import { Callout, Facts, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { decideVenueClaim, type ClaimQueueRow } from "@/lib/venue-claim-actions"
import { formatDay } from "@/lib/dashboard-format"
import { refusalMessage } from "@/lib/refusal"

const DOC_LABELS: Record<string, string> = {
  tradeLicence: "Trade licence",
  fssai: "FSSAI",
  liquor: "Liquor",
  photo: "Photo",
}

/**
 * The claim queue.
 *
 * Same shape as organiser onboarding review, for the same reason: the reviewer
 * is deciding whether to grant access on evidence that cannot be checked
 * automatically. Flags are derived at read time and shown as things to weigh,
 * not as a score — a claim with three flags can still be the right one.
 */
export function VenueClaimQueue({ claims }: { claims: ClaimQueueRow[] }) {
  if (claims.length === 0) {
    return (
      <EmptyState
        icon={<IconBuildingStore />}
        title="No claims waiting"
        description="Venue owners claim a venue to get the events held there. Approving one transfers operational control, so it lands here rather than applying itself."
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

function ClaimCard({ claim }: { claim: ClaimQueueRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function decide(decision: "approve" | "decline", note?: string) {
    startTransition(async () => {
      try {
        const { notified } = await decideVenueClaim(claim.id, decision, note)
        toast.success(
          decision === "approve"
            ? `${claim.orgName} now owns ${claim.venueName}.`
            : notified
              ? "Claim declined — the reason has been emailed to the claimant."
              : "Claim declined — no email went out (email is off here, or their address is unconfirmed). Tell them yourself if you can."
        )
        router.refresh()
      } catch (e) {
        toast.error(refusalMessage(e, "Could not record the decision."))
      }
    })
  }

  const docs = Object.entries(claim.evidence).filter((d): d is [string, string] => !!d[1])

  return (
    <Panel>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[0.9375rem] font-bold">
            <Link href={`/dashboard/venues/${claim.venueId}`} className="underline-offset-4 hover:underline">
              {claim.venueName}
            </Link>
          </h2>
          <Badge variant="secondary">{claim.venueType}</Badge>
          {claim.isDispute ? <Badge variant="destructive">Dispute</Badge> : null}
          <span className="ml-auto text-[0.75rem] text-faint-foreground">
            Filed {formatDay(claim.createdAt.toISOString())}
          </span>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">{claim.venueAddress ?? "No address on record"}</p>
      </div>

      <Facts
        items={[
          {
            label: "Claimed by",
            value: (
              <>
                <span className="font-medium">{claim.orgName}</span>
                {!claim.filedByName && claim.contactEmail ? (
                  <span className="text-muted-foreground"> · no account yet</span>
                ) : claim.filedByName ? (
                  <span className="text-muted-foreground"> · {claim.filedByName}</span>
                ) : null}
                {claim.contactEmail ? (
                  <span className="block text-muted-foreground">{claim.contactEmail}</span>
                ) : null}
              </>
            ),
          },
          { label: "GSTIN", value: claim.gstin ? <Gstin gstin={claim.gstin} check={claim.gstinCheck} /> : null },
        ]}
      />

      {claim.note ? <p className="text-[0.8125rem] leading-6 text-muted-foreground">{claim.note}</p> : null}

      {claim.isDispute && claim.currentOwnerName ? (
        <Callout title={`Currently owned by ${claim.currentOwnerName}`}>
          {claim.currentOwnerEventCount} event{claim.currentOwnerEventCount === 1 ? "" : "s"} hosted here. Approving
          transfers the venue away from them.
        </Callout>
      ) : null}

      <EvidenceDocs docs={docs} labels={DOC_LABELS} />
      <ClaimFlags flags={claim.flags} />

      {claim.waitingOn ? (
        /*
         * Shown before the buttons, not learned from a failed submit: filed
         * from the public page with no account, so the venue cannot be handed
         * over until the address is proved and the application approved.
         */
        <Callout>
          {claim.waitingOn === "email" ? (
            "Their email address is not confirmed yet. Approving waits until they click the link we sent."
          ) : (
            <>
              Their application is still waiting. Approve it on{" "}
              <Link href="/dashboard/onboarding" className="underline underline-offset-4 hover:text-foreground">
                Applications
              </Link>{" "}
              first; approving this claim then hands the venue to the organisation it creates.
            </>
          )}
        </Callout>
      ) : null}

      <DecideBox
        approveLabel={claim.isDispute ? "Transfer venue" : "Approve claim"}
        sendLabel="Send decline"
        reasonLabel={`Why the claim on ${claim.venueName} is declined`}
        placeholder="Why this was declined — it is sent to the claimant, and a decline with no reason produces an identical re-file."
        pending={pending}
        approveDisabled={claim.waitingOn !== null}
        onApprove={() => decide("approve")}
        onDecline={(reason) => decide("decline", reason)}
      />
    </Panel>
  )
}
