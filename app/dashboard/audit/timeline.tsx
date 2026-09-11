"use client"

import { useMemo, useState } from "react"
import { IconChevronRight } from "@tabler/icons-react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { AuditEntry, AuditPage } from "@/lib/audit-actions"

/**
 * A timeline rather than a table.
 *
 * The question here is "what happened, in order" and the rows are not
 * comparable to each other the way table rows are — an `org.invite` and a
 * `moderation.removed` share no columns worth aligning. Grouping by day and
 * letting each entry expand its own JSON reads better than nine sparse columns.
 */

/** Destructive or privilege-granting actions carry weight and should look it. */
const WEIGHTY = /suspend|declin|remov|revok|delet|ban|override|role_changed|password/

// A word in mono, not a chip. A hundred rows of orange chips said nothing;
// the one class worth a colour is the weighty one — suspensions, deletions,
// role changes — and it gets the destructive tone.
function actionTone(action: string): string {
  return WEIGHTY.test(action) ? "font-bold text-destructive" : "text-foreground"
}

export function AuditTimeline({ page }: { page: AuditPage }) {
  const [action, setAction] = useState("all")
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return page.entries.filter((e) => {
      if (action !== "all" && e.action !== action) return false
      if (!needle) return true
      return [e.action, e.resource, e.resourceId, e.actor?.name, e.actor?.email]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    })
  }, [page.entries, action, query])

  // Grouped by day, so scanning "what happened Tuesday" does not mean reading
  // every timestamp.
  const days = useMemo(() => {
    const map = new Map<string, AuditEntry[]>()
    for (const entry of filtered) {
      const key = entry.createdAt.toDateString()
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filtered])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search actor, resource, id…"
          aria-label="Search the audit log"
          className="h-9 w-64 text-[0.8125rem]"
        />
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" className="w-auto min-w-44" aria-label="Action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {page.actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[0.75rem] text-faint-foreground">
          {filtered.length} of {page.total} shown
          {page.total > page.entries.length ? " · most recent 100 loaded" : ""}
        </span>
      </div>

      {days.map(([day, entries]) => (
        <section key={day} className="flex flex-col gap-1.5">
          <h2 className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {day}
          </h2>
          <div className="divide-y divide-border border-t border-border">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      ))}

      {filtered.length === 0 ? (
        <p className="py-7 text-[0.8125rem] text-muted-foreground">
          Nothing matches those filters.
        </p>
      ) : null}
    </div>
  )
}

function Entry({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const hasDetails = entry.details !== null && entry.details !== undefined

  return (
    <div className="text-[0.8125rem]">
      <button
        onClick={() => hasDetails && setOpen((o) => !o)}
        disabled={!hasDetails}
        className={cn(
          "flex w-full flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-left",
          hasDetails && "cursor-pointer hover:bg-accent"
        )}
      >
        <span className="w-14 shrink-0 tabular-nums text-faint-foreground">
          {entry.createdAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span className={cn("w-44 shrink-0 truncate font-mono text-[0.6875rem]", actionTone(entry.action))}>
          {entry.action}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {/* Some entries have no actor at all — an application submitted at
              /apply is written before any account exists. "System" is honest;
              attributing it to nobody-in-particular would not be. */}
          <span className="font-medium">{entry.actor?.name ?? entry.actor?.email ?? "System"}</span>
          <span className="text-muted-foreground">
            {" "}
            · {entry.resource}
            {entry.resourceId ? ` ${entry.resourceId.slice(0, 8)}` : ""}
          </span>
        </span>
        {entry.ipAddress ? (
          <span className="hidden font-mono text-[0.6875rem] text-faint-foreground @2xl/main:inline">
            {entry.ipAddress}
          </span>
        ) : null}
        {hasDetails ? (
          <IconChevronRight
            className={cn("size-4 shrink-0 text-faint-foreground transition-transform", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open && hasDetails ? (
        <pre className="overflow-x-auto border-t border-border bg-surface-raised px-3.5 py-2.5 text-[0.6875rem] leading-5">
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
