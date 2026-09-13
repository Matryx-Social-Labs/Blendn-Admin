"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  IconAlertTriangle,
  IconCheck,
  IconFileCheck,
  IconLoader2,
  IconPaperclip,
} from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { uploadFile } from "@/components/event-form/upload"
import { fileVenueClaim, type ClaimEvidence } from "@/lib/venue-claim-actions"
import { validateGstin, gstinMessage } from "@/lib/gstin"

/**
 * Filing a claim.
 *
 * The claim is an access request, so the screen says what access is being
 * requested rather than presenting itself as a profile form. Nothing here is
 * verified automatically — a person reads it — and the form says so, because a
 * claimant who thinks the GSTIN check is an ownership check will not bother
 * attaching a good licence.
 */

const DOCS = [
  {
    key: "tradeLicence" as const,
    label: "Trade licence or Shops & Establishments registration",
    required: true,
    hint: "The one document that names the address. Everything else is optional.",
  },
  { key: "fssai" as const, label: "FSSAI licence", required: false, hint: "If you serve food." },
  { key: "liquor" as const, label: "Liquor licence", required: false, hint: "If you serve alcohol." },
  {
    key: "photo" as const,
    label: "Photo of the venue",
    required: false,
    hint: "Signage or the frontage helps a reviewer match it to the map.",
  },
]

export function VenueClaimForm({
  venueId,
  venueName,
  isDispute,
  currentOwnerName,
  hostedEvents,
}: {
  venueId: string
  venueName: string
  isDispute: boolean
  currentOwnerName: string | null
  hostedEvents: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [gstin, setGstin] = useState("")
  const [evidence, setEvidence] = useState<ClaimEvidence>({})
  const [uploading, setUploading] = useState<string | null>(null)

  const gstinResult = gstin.trim() ? validateGstin(gstin) : null

  async function attach(key: keyof ClaimEvidence, file: File) {
    setUploading(key)
    try {
      const url = await uploadFile(file)
      setEvidence((e) => ({ ...e, [key]: url }))
    } catch {
      toast.error("Upload failed. Try again.")
    } finally {
      setUploading(null)
    }
  }

  function submit() {
    startTransition(async () => {
      try {
        const { isDispute: filedAsDispute } = await fileVenueClaim({
          venueId,
          gstin: gstin.trim() || undefined,
          evidence,
        })
        toast.success(
          filedAsDispute
            ? "Claim filed as a dispute. An admin will weigh both sides."
            : "Claim filed. An admin will review it."
        )
        router.push(`/dashboard/venues/${venueId}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not file the claim.")
      }
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <h3 className="text-[0.9375rem] font-bold">What approval gives you</h3>
        <ul className="flex flex-col gap-1.5 text-[0.8125rem] text-muted-foreground">
          <li>· Events another organiser holds at {venueName} link to you automatically.</li>
          <li>· You see the attendee count, the chatroom and the feedback for those events.</li>
          <li>· Organisers can unlink an event from your venue at any time, with a reason.</li>
        </ul>
        <p className="text-[0.75rem] text-faint-foreground">
          That last line is why this is reviewed rather than automatic, and also why a mistake
          here is recoverable.
        </p>
      </section>

      {isDispute ? (
        <section className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4">
          <p className="flex items-center gap-2 text-[0.8125rem] font-bold">
            <IconAlertTriangle className="size-4 text-warning" />
            This venue already has an owner
          </p>
          <p className="text-[0.8125rem] text-muted-foreground">
            {currentOwnerName ?? "Another organisation"} owns {venueName} and has hosted{" "}
            {hostedEvents} event{hostedEvents === 1 ? "" : "s"} here. Your claim is filed as a
            dispute: an admin sees both sides, and their hosting history counts as evidence.
            Attach documents that outweigh it.
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-4 border-t border-border pt-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="gstin">GSTIN (optional)</Label>
          <Input
            id="gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            placeholder="29AABCU9603R1ZJ"
            maxLength={15}
            className="max-w-[20rem] font-mono"
            aria-describedby="gstin-note"
          />
          <p id="gstin-note" className="text-[0.75rem] text-faint-foreground">
            {gstinResult
              ? gstinMessage(gstinResult)
              : "Checked for a valid format and check digit only — we cannot confirm it is yours."}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Documents</Label>
          {DOCS.map((doc) => {
            const attached = evidence[doc.key]
            return (
              <div
                key={doc.key}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first-of-type:border-t-0"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[0.8125rem] font-medium">
                    {doc.label}
                    {doc.required ? (
                      <span className="text-[0.75rem] font-normal text-muted-foreground">required</span>
                    ) : null}
                  </span>
                  <span className="text-[0.75rem] text-faint-foreground">{doc.hint}</span>
                </span>

                {attached ? (
                  <span className="flex items-center gap-1.5 text-[0.78125rem] text-success">
                    <IconCheck className="size-4" />
                    Attached
                  </span>
                ) : (
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void attach(doc.key, file)
                      }}
                    />
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-[0.78125rem]">
                      {uploading === doc.key ? (
                        <IconLoader2 className="size-3.5 animate-spin" />
                      ) : (
                        <IconPaperclip className="size-3.5" />
                      )}
                      Attach
                    </span>
                  </label>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={pending || !evidence.tradeLicence || (gstinResult ? !gstinResult.valid : false)}
        >
          {pending ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconFileCheck className="size-4" />
          )}
          {isDispute ? "File dispute" : "File claim"}
        </Button>
      </div>
    </div>
  )
}
