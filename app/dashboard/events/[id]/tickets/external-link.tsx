"use client"

import { useId, useState } from "react"
import { IconExternalLink, IconLoader2 } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import { saveTicketLink } from "./actions"
import { useTicketAction } from "./use-action"

/** The host the app's button names, as the server derives it (`externalSiteOf`): www. dropped. Only a preview here. */
function siteOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === "https:" ? u.hostname.replace(/^www\./i, "") || null : null
  } catch {
    return null
  }
}

/**
 * Canada (any market set to external): a link out, no payouts, no fees, no
 * terms (mockup state 7). The sale is between the organizer and that site;
 * nothing on our side fetches the link.
 */
export function ExternalLinkForm({ eventId, url: saved, countryName }: { eventId: string; url: string | null; countryName: string }) {
  const id = useId()
  const [url, setUrl] = useState(saved ?? "")
  const { pending, run } = useTicketAction()
  const site = siteOf(url.trim())

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        run(() => saveTicketLink(eventId, url))
      }}
    >
      <p className="max-w-[720px] text-sm text-muted-foreground">
        Blend’n doesn’t sell tickets for events in {countryName} yet. Paste the page where you sell them and the app shows a button that opens it.
      </p>
      <div className="flex max-w-[720px] flex-col gap-1.5">
        <label htmlFor={id} className="text-[0.8125rem] font-medium text-muted-foreground">
          Ticket page
        </label>
        <Input
          id={id}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.eventbrite.ca/e/…"
          className="font-mono text-[0.8125rem]"
          maxLength={2048}
          aria-describedby={`${id}-help`}
        />
        <span id={`${id}-help`} className="text-[0.75rem] text-faint-foreground">
          https only. The button names the site from the link. Leave it empty to stay free with “I’m going”.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium text-muted-foreground">In the app it reads</span>
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <span className="inline-flex h-9 items-center rounded-full border border-border px-3.5 text-sm">I’m going</span>
          {site ? (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong px-3.5 text-sm">
              Tickets on {site}
              <IconExternalLink aria-hidden className="size-3.5" />
            </span>
          ) : null}
        </div>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
          Save link
        </Button>
      </div>
    </form>
  )
}
