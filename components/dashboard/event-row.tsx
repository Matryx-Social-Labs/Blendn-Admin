import { IconChevronRight } from "@tabler/icons-react"

import { DateBlock, Row, Status } from "@/components/dashboard/kit"
import { attendanceLine, type EventRowData } from "@/lib/event-row"

/**
 * One number and a bar: who is going, who has checked in, or who came,
 * depending on where the event is in its life (`attendanceLine`).
 *
 * The bar is decoration — the sentence beside it carries the figures — so it
 * is hidden from assistive tech rather than announced as a second, unlabelled
 * progress bar.
 */
export function EventAttendance({ row }: { row: Pick<EventRowData, "phase" | "capacity" | "going" | "arrivals"> }) {
  const { value, label, pct } = attendanceLine(row)
  return (
    <span className="flex w-full min-w-0 flex-col gap-1.5">
      <span className="text-[0.78125rem] tabular-nums">
        {value === null ? (
          <span className="font-bold text-faint-foreground">—</span>
        ) : (
          <b className="font-bold">{value}</b>
        )}{" "}
        <span className="text-faint-foreground">{label}</span>
      </span>
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-surface-raised">
        {pct !== null ? (
          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        ) : null}
      </span>
    </span>
  )
}

/** The calendar tile, red and reading "Live" while the night runs. */
export function EventDate({ row }: { row: Pick<EventRowData, "day" | "month" | "phase"> }) {
  return <DateBlock day={row.day} month={row.month} live={row.phase === "live"} />
}

export function EventStatus({ row }: { row: Pick<EventRowData, "status" | "phase" | "unfenced"> }) {
  return <Status status={row.status} live={row.phase === "live"} unfenced={row.unfenced} />
}

/**
 * The kit's event row: date tile, title over when and where, status, the
 * attendance cell, and the whole row a link to the event.
 *
 * Inside a `@container/rows` list: below `@xl` of it, the status and
 * attendance drop under the title rather than squeezing it to a word.
 */
export function EventRow({ row }: { row: EventRowData }) {
  return (
    <Row href={`/dashboard/events/${row.id}`} className="flex-wrap @xl/rows:flex-nowrap">
      <EventDate row={row} />
      <span className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{row.title}</span>
        <span className="truncate text-[0.78125rem] text-muted-foreground">
          {row.where ? `${row.when} · ${row.where}` : row.when}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-4 pl-[58px] @xl/rows:w-auto @xl/rows:pl-0">
        <span className="w-24 shrink-0 @xl/rows:w-28">
          <EventStatus row={row} />
        </span>
        <span className="flex min-w-0 flex-1 @xl/rows:w-36 @xl/rows:flex-none">
          <EventAttendance row={row} />
        </span>
      </span>
      <IconChevronRight aria-hidden className="hidden size-4 shrink-0 text-faint-foreground @xl/rows:block" />
    </Row>
  )
}
