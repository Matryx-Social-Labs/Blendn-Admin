"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/dashboard/kit"
import { Switch } from "@/components/ui/switch"
import { refusalMessage } from "@/lib/refusal"
import { setVenueOpenOnBlendn } from "@/lib/venue-actions"

/**
 * "Open on Blendn" (D-13): whether a claimed venue is in the app's Places and
 * on its map. The sentence under the switch says what it does in the app's
 * words, on and off, because "listed" alone does not say that the events stay.
 *
 * Saves on its own, not with the record's Save: it is one fact with its own
 * audit row, and a switch that waited for another button would read as done.
 */
export function OpenOnBlendn({ venueId, name, open }: { venueId: string; name: string; open: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  // What the switch shows while the write is in flight; the server's answer
  // replaces it on refresh.
  const [checked, setChecked] = useState(open)

  const change = (next: boolean) => {
    setChecked(next)
    start(async () => {
      try {
        await setVenueOpenOnBlendn(venueId, next)
        toast.success(next ? `${name} is back in Places` : `${name} has left Places and the map`)
        router.refresh()
      } catch (error) {
        setChecked(!next)
        toast.error(refusalMessage(error, "Could not change it"))
      }
    })
  }

  return (
    <Panel title="In the app" hint="Places and the map">
      <Switch label="Open on Blendn" checked={checked} onCheckedChange={change} disabled={pending} aria-describedby="open-on-blendn-line" />
      <p id="open-on-blendn-line" className={checked ? "text-[0.8125rem] text-muted-foreground" : "text-[0.8125rem] text-warning"}>
        {checked
          ? `People find ${name} in the app's Places and on its map. Switch it off to take it out of both — your events still show.`
          : `Off: ${name} is not in the app's Places or on its map. Your events still show, and say where they are.`}
      </p>
    </Panel>
  )
}
