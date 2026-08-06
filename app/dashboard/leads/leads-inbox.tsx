"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  IconAlertTriangle,
  IconCopy,
  IconDownload,
  IconInbox,
  IconLoader2,
  IconMail,
  IconSearch,
  IconX,
} from "@tabler/icons-react"
import type { lead_status } from "@prisma/client"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { formatSince } from "@/lib/dashboard-format"
import { addLeadNote, assignLead, setLeadStatus, getLeadDetail, type LeadDetail } from "@/lib/lead-actions"
import type { LeadRow } from "@/lib/lead-queries"

/**
 * The lead inbox.
 *
 * Client, because the columns carry `render` functions and `DataTable` is a
 * client component — the boundary rule that broke the dashboard root once
 * already. `__tests__/rsc-boundary.test.ts` enforces it now.
 *
 * Defaults to open leads, not everything. An unfiltered list of every lead ever
 * received is history; the inbox should show work.
 */

const STATUS_TONE: Record<lead_status, string> = {
  new: "border-primary bg-primary/10 text-foreground",
  contacted: "border-border-strong",
  qualified: "border-border-strong",
  converted: "border-success/50 text-success",
  archived: "border-border text-faint-foreground",
  spam: "border-destructive/40 text-destructive",
}

const FILTERS: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "open", label: "Open" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "converted", label: "Converted" },
  { key: "spam", label: "Spam" },
  { key: "all", label: "All" },
]

const columns: Column<LeadRow>[] = [
  {
    key: "status",
    label: "Status",
    sortType: "string",
    render: (r) => (
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide",
          STATUS_TONE[r.status]
        )}
      >
        {r.status}
      </span>
    ),
  },
  { key: "email", label: "Email", sortType: "string", primary: true },
  {
    key: "name",
    label: "Name / org",
    sortType: "string",
    // Never blank — an empty cell reads as a rendering bug rather than a lead
    // who did not fill the field in.
    render: (r) => (
      <span className="flex flex-col">
        <span>{r.name || "—"}</span>
        {r.organization ? (
          <span className="text-[0.71875rem] text-faint-foreground">{r.organization}</span>
        ) : null}
      </span>
    ),
  },
  { key: "city", label: "City", sortType: "string", render: (r) => r.city || "—", secondary: true },
  {
    key: "eventTypes",
    label: "Runs",
    sortable: false,
    secondary: true,
    // The most useful qualifying field, and usually a sentence. Truncated with
    // the full text on hover.
    render: (r) =>
      r.eventTypes ? (
        <span className="block max-w-[16rem] truncate" title={r.eventTypes}>
          {r.eventTypes}
        </span>
      ) : (
        "—"
      ),
  },
  {
    key: "submittedAt",
    label: "Waiting",
    align: "right",
    sortType: "number",
    sortValue: (r) => r.hoursWaiting ?? -1,
    // Time-in-new, front and centre. A lead sitting untouched for four days is
    // the actual failure mode, and it is invisible unless it is on screen.
    render: (r) =>
      r.hoursWaiting === null ? (
        <span className="text-faint-foreground" title={r.submittedAt}>
          {formatSince(r.submittedAt)}
        </span>
      ) : (
        <span
          className={cn(
            "tabular-nums",
            r.hoursWaiting >= 48 && "font-bold text-destructive",
            r.hoursWaiting >= 24 && r.hoursWaiting < 48 && "text-warning"
          )}
          title={r.submittedAt}
        >
          {r.hoursWaiting < 1 ? "<1h" : `${r.hoursWaiting}h`}
        </span>
      ),
  },
  {
    key: "assignedToName",
    label: "Assigned",
    sortType: "string",
    secondary: true,
    render: (r) => r.assignedToName || <span className="text-faint-foreground">Unassigned</span>,
  },
]

export function LeadsInbox({
  rows,
  assignees,
}: {
  rows: LeadRow[]
  assignees: { id: string; name: string | null; email: string }[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  // Driven by the URL, not local state: the notification email links straight
  // to `?lead=<id>`, and that has to open the drawer on arrival.
  const openLead = params.get("lead")

  const status = params.get("status") ?? "new"
  const q = params.get("q") ?? ""

  // Filters live in the URL so a filtered view is shareable in Slack.
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value) next.set(key, value)
      else next.delete(key)
      router.replace(`/dashboard/leads?${next.toString()}`)
    },
    [params, router]
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setParam("status", f.key)}
            aria-pressed={status === f.key}
            className={cn(
              "rounded-full border px-3 py-1.5 text-[0.78125rem]",
              status === f.key ? "border-primary bg-surface-raised font-bold" : "border-border"
            )}
          >
            {f.label}
          </button>
        ))}

        <div className="relative ml-auto">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
          <Input
            defaultValue={q}
            onKeyDown={(e) => {
              if (e.key === "Enter") setParam("q", (e.target as HTMLInputElement).value || null)
            }}
            placeholder="Email, name, org, city…"
            className="h-9 w-[16rem] pl-8 text-[0.8125rem]"
            aria-label="Search leads"
          />
        </div>

        <Button asChild variant="outline" size="sm">
          {/* Respects the active filter — the export is of what you are looking at. */}
          <a href={`/api/leads/export?${params.toString()}`}>
            <IconDownload className="size-4" />
            CSV
          </a>
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        sortable
        defaultSort={{ key: "submittedAt", dir: "desc" }}
        pagination
        columnMenu
        rowHref={(r) => `/dashboard/leads?${withParam(params.toString(), "lead", r.id)}`}
        emptyState={
          <EmptyState
            icon={<IconInbox />}
            title={status === "new" ? "Nothing waiting" : "No leads match"}
            description={
              status === "new"
                ? "New demo requests from organizers.blendn.app land here and fire a notification. An empty inbox means everything has been picked up."
                : "Try a different status, or clear the search."
            }
          />
        }
      />

      {openLead ? (
        <LeadDrawer
          leadId={openLead}
          row={rows.find((r) => r.id === openLead)}
          assignees={assignees}
          onClose={() => setParam("lead", null)}
        />
      ) : null}
    </div>
  )
}

/**
 * A drawer rather than a page: you want to triage ten in a row without losing
 * your place in the list.
 */
function LeadDrawer({
  leadId,
  row,
  assignees,
  onClose,
}: {
  leadId: string
  row: LeadRow | undefined
  assignees: { id: string; name: string | null; email: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [detail, setDetail] = useState<LeadDetail | null>(null)
  const [note, setNote] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getLeadDetail(leadId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load the lead.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [leadId])

  function act(fn: () => Promise<void>, ok: string) {
    startTransition(async () => {
      try {
        await fn()
        toast.success(ok)
        router.refresh()
        getLeadDetail(leadId).then(setDetail).catch(() => {})
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That did not work.")
      }
    })
  }

  const NEXT: Record<lead_status, lead_status[]> = {
    new: ["contacted", "archived", "spam"],
    contacted: ["qualified", "archived", "spam"],
    qualified: ["converted", "archived", "spam"],
    converted: ["archived"],
    archived: ["contacted"],
    spam: ["contacted"],
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[32rem] flex-col gap-5 overflow-y-auto bg-card p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Lead detail"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[length:var(--text-h2)] font-bold">{row?.name || row?.email}</h2>
            {row?.organization ? (
              <p className="text-[0.8125rem] text-muted-foreground">{row.organization}</p>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <IconX className="size-4" />
          </Button>
        </div>

        {row ? (
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`mailto:${row.email}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-[0.78125rem]"
            >
              <IconMail className="size-3.5" />
              {row.email}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(row.email)
                toast.success("Email copied")
              }}
            >
              <IconCopy className="size-3.5" />
              Copy
            </Button>
          </div>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            Loading…
          </p>
        ) : null}

        {/* The highest-value widget here: whether this person already applied,
            so nobody chases someone who signed up last week. */}
        {detail?.application ? (
          <div className="flex flex-col gap-1 rounded-lg border border-success/40 bg-success/5 p-4">
            <p className="text-[0.8125rem] font-bold">Already applied</p>
            <p className="text-[0.78125rem] text-muted-foreground">
              {detail.application.displayName} — application is{" "}
              <b>{detail.application.status}</b>, filed {formatSince(detail.application.createdAt.toISOString())}.
            </p>
          </div>
        ) : detail ? (
          <p className="flex items-center gap-2 text-[0.78125rem] text-faint-foreground">
            <IconAlertTriangle className="size-3.5" />
            No application from this address yet.
          </p>
        ) : null}

        <dl className="flex flex-col gap-2 text-[0.8125rem]">
          <Field label="City" value={row?.city} />
          <Field label="Runs" value={row?.eventTypes} />
          <Field label="Source" value={row?.source} />
          <Field
            label="Waiting"
            value={row?.hoursWaiting === null ? "Contacted" : `${row?.hoursWaiting ?? 0}h`}
          />
        </dl>

        {row ? (
          <div className="flex flex-col gap-2">
            <p className="text-[0.75rem] font-bold uppercase tracking-wide text-faint-foreground">
              Move to
            </p>
            <div className="flex flex-wrap gap-2">
              {NEXT[row.status].map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={s === "spam" ? "destructive" : "outline"}
                  disabled={pending}
                  onClick={() => act(() => setLeadStatus(leadId, s), `Moved to ${s}.`)}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <label
            htmlFor="lead-assign"
            className="text-[0.75rem] font-bold uppercase tracking-wide text-faint-foreground"
          >
            Assigned to
          </label>
          <select
            id="lead-assign"
            className="h-9 rounded-md border border-border bg-background px-2 text-[0.8125rem]"
            defaultValue=""
            disabled={pending}
            onChange={(e) =>
              act(() => assignLead(leadId, e.target.value || null), "Assignment saved.")
            }
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.email}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-[0.75rem] font-bold uppercase tracking-wide text-faint-foreground">
            Notes
          </p>
          {detail?.notes.length ? (
            <ul className="flex flex-col gap-2">
              {detail.notes.map((n) => (
                <li key={n.id} className="rounded-md border border-border px-3 py-2">
                  <p className="text-[0.8125rem]">{n.body}</p>
                  <p className="mt-1 text-[0.71875rem] text-faint-foreground">
                    {n.author ?? "Someone"} · {formatSince(n.createdAt.toISOString())}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.78125rem] text-faint-foreground">
              Nothing yet. Notes are append-only — &ldquo;called, no answer&rdquo; and
              &ldquo;called again, keen&rdquo; are both worth keeping.
            </p>
          )}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened?"
            rows={2}
          />
          <Button
            type="button"
            size="sm"
            disabled={pending || note.trim().length < 2}
            onClick={() =>
              act(async () => {
                await addLeadNote(leadId, note)
                setNote("")
              }, "Note added.")
            }
          >
            Add note
          </Button>
        </div>
      </aside>
    </div>
  )
}

/** Add or replace one search param without disturbing the rest of the filter. */
function withParam(qs: string, key: string, value: string): string {
  const next = new URLSearchParams(qs)
  next.set(key, value)
  return next.toString()
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border pb-1.5 last:border-0">
      <dt className="text-faint-foreground">{label}</dt>
      <dd className="text-right">{value || "—"}</dd>
    </div>
  )
}
