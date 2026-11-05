"use client"

import Link from "next/link"
import { Fragment, useState } from "react"
import { IconLoader2 } from "@tabler/icons-react"

import { Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatCount, formatMinor } from "@/lib/money"
import { ticketFees, type FeeRule, type FeeSchedule } from "@/lib/ticket-fees"
import { cn } from "@/lib/utils"

import { saveTicketTypeForm } from "./actions"
import { useTicketAction } from "./use-action"

/**
 * Ticket types, read and edited in one panel (mockup states 3 and 4). Price,
 * quantity and window apply to new orders only; a paid order keeps what it
 * paid (`saveTicketType`). A type with sales is taken off sale, never
 * deleted. At the cap, Add type says why.
 */

export interface TypeRow {
  id: string
  name: string
  priceMinor: number
  quantity: number
  sold: number
  held: number
  maxPerOrder: number
  hidden: boolean
  /** The window as the server words it on the event's clock: "Until Sat 15 Nov, 5 PM". */
  windowLabel: string
  /** `datetime-local` values on the event's clock, for the editor. */
  startsLocal: string
  endsLocal: string
}

interface Props {
  eventId: string
  types: TypeRow[]
  max: number
  maxPerOrderCap: number
  currency: string
  schedule: FeeSchedule
  rule: FeeRule
  feesAbsorbed: boolean
  paidTicketsBefore: number
  /** No types yet: the editor opens on Add type (after Accept, mockup "add your first ticket type"). */
  startEditing?: boolean
}

/** Rows shown before "Show N more types". */
const FOLD = 8
/** At or under this many left, a type says so in amber (contract §1 uses the same 20). */
const FEW_LEFT = 20
const BLANK = "new"

function Capacity({ t }: { t: TypeRow }) {
  const taken = t.sold + t.held
  const left = Math.max(0, t.quantity - taken)
  const pct = t.quantity ? Math.min(100, (t.sold / t.quantity) * 100) : 0
  return (
    <div className="flex items-center gap-2.5">
      <span className="hidden h-1.5 w-[110px] shrink-0 overflow-hidden rounded-full bg-surface-raised @xl/main:block" aria-hidden>
        <i className="block h-full rounded-full bg-muted-foreground" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums">
        {formatCount(t.sold)} / {formatCount(t.quantity)}
      </span>
      {left === 0 ? (
        <span className="text-[0.8125rem] font-medium text-faint-foreground">Sold out</span>
      ) : left <= FEW_LEFT && !t.hidden ? (
        <span className="text-[0.8125rem] font-medium text-warning">{left} left</span>
      ) : null}
    </div>
  )
}

export function TypesPanel(p: Props) {
  const [editing, setEditing] = useState(Boolean(p.startEditing))
  const [open, setOpen] = useState<string | null>(p.startEditing ? BLANK : null)
  const [all, setAll] = useState(false)
  const shown = all ? p.types : p.types.slice(0, FOLD)
  const atCap = p.types.length >= p.max
  const cols = editing ? 6 : 4

  return (
    <Panel
      title="Ticket types"
      hint={`${p.types.length} of ${p.max}`}
      action={
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="outline" onClick={() => (setEditing(false), setOpen(null))}>
                Done
              </Button>
              <Button size="sm" variant="outline" aria-disabled={atCap} onClick={() => !atCap && setOpen(BLANK)} title={atCap ? `An event has at most ${p.max} ticket types` : undefined}>
                Add type
              </Button>
            </>
          ) : (
            <>
              <Button asChild size="sm" variant="outline">
                <Link href={`/dashboard/events/${p.eventId}/door`}>Check tickets</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit types
              </Button>
            </>
          )}
        </div>
      }
    >
      {atCap && editing ? <p className="text-[0.8125rem] text-faint-foreground">{p.max} types is the most an event can have. Take one off sale and edit it instead.</p> : null}
      {p.types.length === 0 && open !== BLANK ? <p className="text-sm text-muted-foreground">No ticket types yet. Add one to start selling.</p> : null}
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[0.75rem] text-faint-foreground">
              <th className="py-2 pr-3 font-medium">Type</th>
              <th className="py-2 pr-3 text-right font-medium">Price</th>
              <th className="py-2 pr-3 font-medium">Sold</th>
              <th className="hidden py-2 pr-3 font-medium @2xl/main:table-cell">On sale</th>
              {editing ? <th className="hidden py-2 pr-3 text-right font-medium @4xl/main:table-cell">Max / order</th> : null}
              {editing ? (
                <th className="py-2">
                  <span className="sr-only">Action</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <Fragment key={t.id}>
                <tr className={cn("border-b border-border", open === t.id && "bg-foreground/[0.03]")}>
                  <td className="min-w-[140px] py-2.5 pr-3 break-words">
                    {open === t.id ? <b>{t.name}</b> : t.name}
                    {t.hidden ? <span className="text-[0.8125rem] text-faint-foreground"> · off sale</span> : null}
                  </td>
                  <td className="py-2.5 pr-3 text-right whitespace-nowrap tabular-nums">{formatMinor(t.priceMinor, p.currency)}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    <Capacity t={t} />
                  </td>
                  <td className="hidden py-2.5 pr-3 whitespace-nowrap text-muted-foreground @2xl/main:table-cell">{t.windowLabel}</td>
                  {editing ? <td className="hidden py-2.5 pr-3 text-right tabular-nums @4xl/main:table-cell">{t.maxPerOrder}</td> : null}
                  {editing ? (
                    <td className="py-2.5 text-right">
                      {open === t.id ? (
                        <span className="text-faint-foreground">Editing</span>
                      ) : (
                        <button type="button" className="font-medium underline underline-offset-[3px]" onClick={() => setOpen(t.id)}>
                          Edit<span className="sr-only"> {t.name}</span>
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
                {open === t.id ? <EditorRow p={p} t={t} cols={cols} onClose={() => setOpen(null)} /> : null}
              </Fragment>
            ))}
            {open === BLANK ? <EditorRow p={p} cols={cols} onClose={() => setOpen(null)} /> : null}
          </tbody>
        </table>
      </div>
      {!all && p.types.length > FOLD ? (
        <Button size="sm" variant="outline" className="self-center" onClick={() => setAll(true)}>
          Show {p.types.length - FOLD} more type{p.types.length - FOLD === 1 ? "" : "s"}
        </Button>
      ) : null}
    </Panel>
  )
}

/** What one ticket of this price costs the buyer now, priced as the next order would be (the fee calculator, client-safe). */
function buyerPays(p: Props, priceMinor: number): { total: number; fee: number } | null {
  if (!(priceMinor > 0)) return null
  try {
    const b = ticketFees({
      schedule: p.schedule,
      paidTicketsBefore: p.paidTicketsBefore,
      lines: [{ ticketTypeId: "00000000-0000-0000-0000-000000000000", unitPriceMinor: priceMinor, quantity: 1 }],
      rule: p.rule,
      feesAbsorbed: p.feesAbsorbed,
    })
    return { total: b.totals.totalMinor, fee: p.feesAbsorbed ? b.totals.serviceFeeMinor + b.totals.serviceFeeTaxMinor + b.totals.processingFeeMinor : b.totals.bookingFeeMinor }
  } catch {
    return null
  }
}

function priceInput(raw: string): number {
  const s = raw.replace(/[₹$,\s]/g, "")
  return /^\d{1,7}(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN
}

function EditorRow({ p, t, cols, onClose }: { p: Props; t?: TypeRow; cols: number; onClose: () => void }) {
  const [form, setForm] = useState({
    name: t?.name ?? "",
    price: t ? String(t.priceMinor / 100) : "",
    quantity: t ? String(t.quantity) : "",
    maxPerOrder: String(t?.maxPerOrder ?? p.maxPerOrderCap),
    salesStart: t?.startsLocal ?? "",
    salesEnd: t?.endsLocal ?? "",
    onSale: t ? (t.hidden ? "" : "on") : "on",
  })
  const { pending, run } = useTicketAction()
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const pays = buyerPays(p, priceInput(form.price))
  const id = t?.id ?? "new"
  const taken = t ? t.sold + t.held : 0

  return (
    <tr className="bg-foreground/[0.03]">
      <td colSpan={cols} className="pt-1 pb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            run(() => saveTicketTypeForm(p.eventId, { ...form, ...(t ? { id: t.id } : {}) }), onClose)
          }}
          className="flex flex-col gap-3.5"
          aria-label={t ? `Edit ${t.name}` : "New ticket type"}
        >
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 @xl/main:grid-cols-2 @4xl/main:grid-cols-4">
            <Field id={`${id}-name`} label="Name">
              <Input id={`${id}-name`} value={form.name} onChange={set("name")} maxLength={80} required />
            </Field>
            <Field id={`${id}-price`} label="Price" help="More than zero: free tickets are “I’m going” with a capacity.">
              <Input id={`${id}-price`} aria-describedby={`${id}-price-help`} value={form.price} onChange={set("price")} inputMode="decimal" className="tabular-nums" required />
            </Field>
            <Field id={`${id}-qty`} label="Quantity" help={taken ? `At least ${formatCount(taken)}, the number sold or being bought.` : undefined}>
              <Input id={`${id}-qty`} aria-describedby={taken ? `${id}-qty-help` : undefined} value={form.quantity} onChange={set("quantity")} inputMode="numeric" className="tabular-nums" required />
            </Field>
            <Field id={`${id}-max`} label="Most per order" help={`1 to ${p.maxPerOrderCap}. A buyer holds at most ${p.maxPerOrderCap} for this event.`}>
              <Input id={`${id}-max`} aria-describedby={`${id}-max-help`} value={form.maxPerOrder} onChange={set("maxPerOrder")} inputMode="numeric" className="tabular-nums" required />
            </Field>
            <Field id={`${id}-start`} label="Sales start" help="Empty: on sale now.">
              <Input id={`${id}-start`} aria-describedby={`${id}-start-help`} type="datetime-local" value={form.salesStart} onChange={set("salesStart")} />
            </Field>
            <Field id={`${id}-end`} label="Sales end" help="Empty: until the event ends.">
              <Input id={`${id}-end`} aria-describedby={`${id}-end-help`} type="datetime-local" value={form.salesEnd} onChange={set("salesEnd")} />
            </Field>
            <Field id={`${id}-sale`} label="In the app">
              <select
                id={`${id}-sale`}
                value={form.onSale}
                onChange={set("onSale")}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30"
              >
                <option value="on">On sale</option>
                <option value="">Off sale, not listed</option>
              </select>
            </Field>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium text-muted-foreground">A buyer pays now</span>
              <div className="flex h-9 items-center rounded-md border border-dashed border-input px-3 text-sm tabular-nums" aria-live="polite">
                {pays ? formatMinor(pays.total, p.currency, { paise: true }) : "—"}
              </div>
              {pays ? (
                <span className="text-[0.75rem] text-faint-foreground">
                  {p.feesAbsorbed
                    ? `You absorb ${formatMinor(pays.fee, p.currency, { paise: true })} in fees`
                    : `${formatMinor(priceInput(form.price), p.currency)} + booking fee ${formatMinor(pays.fee, p.currency, { paise: true })}`}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
              Save
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <span className="text-[0.8125rem] text-faint-foreground">{t ? "Paid orders keep what they paid. The change is logged." : "It goes on sale as soon as you save, unless it is off sale."}</span>
          </div>
        </form>
      </td>
    </tr>
  )
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {help ? <span id={`${id}-help`} className="text-[0.75rem] text-faint-foreground">{help}</span> : null}
    </div>
  )
}
