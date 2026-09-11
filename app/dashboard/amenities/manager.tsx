"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { createAmenity, setAmenityActive, updateAmenity } from "@/lib/amenity-actions"
import type { AmenityRow } from "@/lib/amenity-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Add, rename, reorder and retire amenities.
 *
 * Retiring is the operation this screen exists for, and it is deliberately not
 * a delete: `event_amenities` is `onDelete: Restrict`, because removing an
 * amenity would rewrite what past events said they offered. A retired one stops
 * being offered and still resolves on the events that already reference it.
 *
 * The event count is shown next to it for the same reason the category manager
 * shows interest counts — an admin deciding what to withdraw should be able to
 * see how much history it is attached to before they do.
 */
export function AmenityManager({ amenities }: { amenities: AmenityRow[] }) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [subtitle, setSubtitle] = useState("")
  const [icon, setIcon] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")

  const run = (fn: () => Promise<void>, ok: string) =>
    startTransition(async () => {
      try {
        await fn()
        toast.success(ok)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That did not work")
      }
    })

  const active = amenities.filter((a) => a.isActive)
  const retired = amenities.filter((a) => !a.isActive)

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1">
        <h2 className="text-[0.9375rem] font-bold">Offered <span className="font-normal text-muted-foreground">{active.length}</span></h2>
        {active.map((a) => (
          <Row
            key={a.id}
            amenity={a}
            pending={pending}
            editing={editing === a.id}
            editName={editName}
            onEditName={setEditName}
            onStartEdit={() => {
              setEditing(a.id)
              setEditName(a.name)
            }}
            onCancelEdit={() => setEditing(null)}
            onSave={() =>
              run(async () => {
                await updateAmenity(a.id, { name: editName })
                setEditing(null)
              }, "Renamed")
            }
            onToggle={() =>
              run(() => setAmenityActive(a.id, false), `${a.name} retired`)
            }
          />
        ))}
      </section>

      {retired.length > 0 ? (
        <section className="flex flex-col gap-1 border-t border-border pt-5">
          <h2 className="text-[0.9375rem] font-bold">Retired <span className="font-normal text-muted-foreground">{retired.length}</span></h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            Not offered for new events. Still shown on the events that already list them —
            withdrawing an amenity should not rewrite what a past event said.
          </p>
          {retired.map((a) => (
            <Row
              key={a.id}
              amenity={a}
              pending={pending}
              editing={false}
              editName=""
              onEditName={() => {}}
              onStartEdit={() => {}}
              onCancelEdit={() => {}}
              onSave={() => {}}
              onToggle={() => run(() => setAmenityActive(a.id, true), `${a.name} restored`)}
            />
          ))}
        </section>
      ) : null}
      <section className="border-t border-border pt-5">
        <h2 className="text-[0.9375rem] font-bold">Add an amenity</h2>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          The label as drawn, an optional second line, and a Material Symbols name so the app
          does not carry its own slug-to-glyph mapping and drift from this list.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="amenity-name">Name</Label>
            <Input
              id="amenity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Open Bar"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="amenity-subtitle">Subtitle</Label>
            <Input
              id="amenity-subtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Premium Spirits"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="amenity-icon">Icon</Label>
            <Input
              id="amenity-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="local_bar"
            />
          </div>
          <Button
            disabled={pending || name.trim().length < 2}
            onClick={() =>
              run(async () => {
                await createAmenity({ name, subtitle, icon })
                setName("")
                setSubtitle("")
                setIcon("")
              }, "Amenity added")
            }
          >
            Add
          </Button>
        </div>
      </section>

    </div>
  )
}

function Row({
  amenity,
  pending,
  editing,
  editName,
  onEditName,
  onStartEdit,
  onCancelEdit,
  onSave,
  onToggle,
}: {
  amenity: AmenityRow
  pending: boolean
  editing: boolean
  editName: string
  onEditName: (v: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onToggle: () => void
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-b border-border py-2.5 last:border-0",
        !amenity.isActive && "opacity-70"
      )}
    >
      <div className="min-w-0">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input value={editName} onChange={(e) => onEditName(e.target.value)} />
            <Button size="sm" disabled={pending} onClick={onSave}>
              Save
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <span className="font-semibold">{amenity.name}</span>
            {amenity.subtitle ? (
              <span className="ml-2 text-[0.8125rem] text-muted-foreground">
                {amenity.subtitle}
              </span>
            ) : null}
            <span className="ml-2 text-[0.75rem] text-faint-foreground tabular-nums">
              {/* What retiring it would contradict. */}
              {amenity.eventCount} event{amenity.eventCount === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>
      {!editing ? (
        <div className="flex items-center gap-1.5">
          {amenity.isActive ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onStartEdit}>
              Rename
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={pending} onClick={onToggle}>
            {amenity.isActive ? "Retire" : "Restore"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
