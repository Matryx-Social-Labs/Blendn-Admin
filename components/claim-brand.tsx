"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  fileSponsorClaim,
  findClaimableBrands,
  type ClaimableBrand,
  type MyClaimRow,
} from "@/lib/sponsor-claim-actions"

/**
 * Claim a brand an organiser already added.
 *
 * This sits *above* the create form on purpose. Without it, a sponsor whose
 * brand was already added to three events by three different organisers creates
 * a fourth row, and an admin has to merge four brands that should have been one.
 * The duplicate is cheapest to prevent here, at the only moment somebody knows
 * for certain which rows are the same company.
 *
 * Only unclaimed brands are searchable. A brand somebody else owns is a dispute,
 * and a dispute should not be something you stumble into from a search box.
 */
export function ClaimBrand({ claims }: { claims: MyClaimRow[] }) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<{ query: string; rows: ClaimableBrand[] }>({
    query: "",
    rows: [],
  })
  const [picked, setPicked] = useState<ClaimableBrand | null>(null)
  const [authorisation, setAuthorisation] = useState("")
  const [incorporation, setIncorporation] = useState("")
  const [gstin, setGstin] = useState("")
  const [pending, start] = useTransition()
  const seq = useRef(0)

  const q = query.trim()
  const fresh = matches.query === q && q.length >= 2
  const rows = fresh ? matches.rows : []

  useEffect(() => {
    if (q.length < 2) return
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      let found: ClaimableBrand[] = []
      try {
        found = await findClaimableBrands(q)
      } catch {
        found = []
      }
      if (mine !== seq.current) return
      setMatches({ query: q, rows: found })
    }, 250)
    return () => clearTimeout(timer)
  }, [q])

  const pendingClaim = claims.find((c) => c.status === "pending")
  const rejected = claims.filter((c) => c.status === "rejected")

  function file() {
    if (!picked) return
    start(async () => {
      try {
        await fileSponsorClaim({
          sponsorId: picked.id,
          gstin: gstin.trim() || undefined,
          evidence: {
            authorisation: authorisation.trim() || undefined,
            incorporation: incorporation.trim() || undefined,
          },
        })
        toast.success(`Claim filed for ${picked.name}. An admin reviews it.`)
        setPicked(null)
        setQuery("")
        setAuthorisation("")
        setIncorporation("")
        setGstin("")
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not file that claim")
      }
    })
  }

  if (pendingClaim) {
    return (
      <div className="flex max-w-xl flex-col gap-2 rounded-xl border bg-card p-5">
        <h2 className="text-[0.9375rem] font-bold">
          Your claim on {pendingClaim.brandName} is being reviewed
        </h2>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          A person reads every claim, because nothing in the evidence can be
          checked automatically. Once it is approved the brand is yours, along
          with any placements organisers have already attached to it.
        </p>
      </div>
    )
  }

  if (picked) {
    return (
      <div className="flex max-w-xl flex-col gap-5 rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-[0.9375rem] font-bold">Claiming {picked.name}</h2>
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            {picked.placements === 0
              ? "No placements attached yet."
              : `${picked.placements} placement${picked.placements === 1 ? "" : "s"} come with it, including their reporting.`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-authorisation">Authorisation document</Label>
          <Input
            id="claim-authorisation"
            value={authorisation}
            onChange={(e) => setAuthorisation(e.target.value)}
            placeholder="https://…"
          />
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            A letter on company letterhead, or a trademark certificate. This is
            the one thing that cannot be skipped — it is what names the company.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-incorporation">Certificate of incorporation (optional)</Label>
          <Input
            id="claim-incorporation"
            value={incorporation}
            onChange={(e) => setIncorporation(e.target.value)}
            placeholder="https://…"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-gstin">GSTIN (optional)</Label>
          <Input
            id="claim-gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value)}
            placeholder="29ABCDE1234F1Z5"
            className="font-mono"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            Checked by checksum only. It still helps a reviewer, and leaving it
            out is one of the things they are told about.
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            disabled={pending || !authorisation.trim().startsWith("http")}
            onClick={file}
          >
            File claim
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => setPicked(null)}>
            Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex max-w-xl flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[0.9375rem] font-bold">Has your brand already been added?</h2>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          Organisers add brands while setting up an event, so yours may already be
          here with placements attached. Claiming it keeps that history —
          creating a second one splits it in two.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="claim-search">Search brands</Label>
        <Input
          id="claim-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Your company name"
        />
      </div>

      {q.length >= 2 && fresh && rows.length === 0 ? (
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          No unclaimed brand matches “{q}”. Create yours below.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{r.name}</span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {r.website?.replace(/^https?:\/\//, "") ?? "No website"} ·{" "}
                  {r.placements} placement{r.placements === 1 ? "" : "s"}
                </span>
              </div>
              {r.alreadyFiled ? (
                <Badge variant="secondary" className="shrink-0 rounded-full">
                  Claim filed
                </Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setPicked(r)}>
                  Claim
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {rejected.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-4">
          {rejected.map((c) => (
            <div key={c.id} className="flex flex-col gap-1">
              <p className="text-[0.8125rem] font-medium">
                Your claim on {c.brandName} was not approved
              </p>
              {/*
                The reason, verbatim. Without it the same claim gets re-filed
                unchanged, which is the loop the required decision note exists
                to break.
              */}
              <p className="text-[0.8125rem] leading-6 text-muted-foreground">
                {c.decisionNote ?? "No reason was recorded."}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
