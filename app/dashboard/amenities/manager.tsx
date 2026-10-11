"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/dashboard/kit"
import { createAmenity, setAmenityActive, updateAmenity } from "@/lib/amenity-actions"
import type { AmenityRow } from "@/lib/amenity-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { refusalMessage } from "@/lib/refusal"

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
        toast.error(refusalMessage(err, "That did not work"))
      }
    })

  const active = amenities.filter((a) => a.isActive)
  const retired = amenities.filter((a) => !a.isActive)

  /*
   * The kit's Amenities: the list first, the add form last. Two Panels rather
   * than one list with retired rows mixed in, because "Retired" carries the one
   * rule a reader cannot infer — that withdrawing an amenity leaves the events
   * that already list it alone.
   */
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Offered" hint={`${active.length}`} bodyClassName="gap-0 px-5 pb-2 pt-1">
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
      </Panel>

      {retired.length > 0 ? (
        <Panel
          title="Retired"
          hint="not offered for new events · still shown on the events that already list them"
          bodyClassName="gap-0 px-5 pb-2 pt-1"
        >
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
        </Panel>
      ) : null}

      <Panel title="Add an amenity">
        <p className="text-[0.8125rem] text-muted-foreground">
          The label as drawn, an optional second line, and a Material Symbols name so the app
          does not carry its own slug-to-glyph mapping and drift from this list.
        </p>
        <div className="flex flex-wrap items-end gap-3">
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
      </Panel>
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
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0">
      <div className="min-w-0">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
              // Named for the amenity: it had no name at all (SCRUM-469).
              aria-label={`New name for ${amenity.name}`}
            />
            <Button size="sm" disabled={pending} onClick={onSave}>
              Save
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            {/* Dimmed by colour, not opacity: opacity takes the faint words
                under the contrast floor along with the name. */}
            <span className={cn("font-semibold", !amenity.isActive && "text-muted-foreground")}>{amenity.name}</span>
            {amenity.subtitle ? (
              <span className="ml-2 text-[0.8125rem] text-muted-foreground">
                {amenity.subtitle}
              </span>
            ) : null}
            {!amenity.isActive ? (
              <span className="ml-2 text-[0.75rem] text-faint-foreground">retired</span>
            ) : null}
            <span className="ml-2 text-[0.78125rem] text-muted-foreground tabular-nums">
              {/* What retiring it would contradict. */}
              {amenity.eventCount} event{amenity.eventCount === 1 ? " lists" : "s list"} it
            </span>
          </>
        )}
      </div>
      {!editing ? (
        <div className="flex items-center gap-1.5">
          {amenity.isActive ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onStartEdit} aria-label={`Rename ${amenity.name}`}>
              Rename
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onToggle}
            aria-label={`${amenity.isActive ? "Retire" : "Restore"} ${amenity.name}`}
          >
            {amenity.isActive ? "Retire" : "Restore"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
