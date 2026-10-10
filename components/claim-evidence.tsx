import { IconAlertTriangle, IconExternalLink, IconFileText } from "@tabler/icons-react"

/**
 * The parts a venue claim and a brand claim share: the documents filed with
 * it, the warnings derived at read time, and the GSTIN beside its check.
 * Server-safe, so either queue can render them.
 */

/** Documents as chips that open the file. An empty set says so, never a blank. */
export function EvidenceDocs({ docs, labels }: { docs: Array<[string, string]>; labels: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">Evidence</p>
      {docs.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">Nothing attached.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {docs.map(([key, url]) => (
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-[0.78125rem] transition-colors hover:bg-surface-raised pointer-coarse:min-h-11"
            >
              <IconFileText aria-hidden className="size-3.5" />
              {labels[key] ?? key}
              <IconExternalLink aria-hidden className="size-3 text-faint-foreground" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** Things to weigh, not a score: a claim with three of these can still be the right one. */
export function ClaimFlags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5">
      {flags.map((flag) => (
        <li key={flag} className="flex items-start gap-2 text-[0.8125rem] text-muted-foreground">
          <IconAlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {flag}
        </li>
      ))}
    </ul>
  )
}

/** The number in mono, what the checksum said beside it in words. Callers pass null for no GSTIN, so `Facts` says "—". */
export function Gstin({ gstin, check }: { gstin: string; check: string | null }) {
  return (
    <>
      <span className="font-mono">{gstin}</span>
      {check ? <span className="ml-2 text-[0.75rem] text-muted-foreground">{check}</span> : null}
    </>
  )
}
