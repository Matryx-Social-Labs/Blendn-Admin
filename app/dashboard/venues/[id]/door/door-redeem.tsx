"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { redeemPass } from "@/lib/offer-actions"
import { refusalMessage } from "@/lib/refusal"

/**
 * The code field and "Redeemed" (step 12). The answer replaces nothing and
 * names nothing but the offer: the server returns its words and no more.
 */
export function DoorRedeem({ venueId }: { venueId: string }) {
  const [code, setCode] = useState("")
  const [result, setResult] = useState<{ ok: boolean; line: string } | null>(null)
  const [pending, start] = useTransition()

  function redeem(e: React.FormEvent) {
    e.preventDefault()
    if (pending || code.trim().length === 0) return
    start(async () => {
      try {
        const { text } = await redeemPass({ venueId, code })
        setResult({ ok: true, line: `Redeemed: ${text}` })
        setCode("")
      } catch (err) {
        setResult({ ok: false, line: refusalMessage(err, "That didn't go through. Try again.") })
      }
    })
  }

  return (
    <form onSubmit={redeem} className="flex flex-col gap-3">
      <label htmlFor="pass-code" className="text-[0.75rem] text-muted-foreground">
        Pass code
      </label>
      <Input
        id="pass-code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        maxLength={9}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        className="h-14 text-center font-mono text-[1.75rem] font-semibold tracking-[0.3em]"
        aria-describedby="door-result"
      />
      <Button type="submit" size="lg" aria-disabled={pending || code.trim().length === 0}>
        {pending ? "Checking…" : "Redeemed"}
      </Button>
      <p id="door-result" role="status" className={result?.ok ? "text-[0.9375rem] font-semibold text-success" : "text-[0.8125rem] text-warning"}>
        {result?.line ?? ""}
      </p>
    </form>
  )
}
