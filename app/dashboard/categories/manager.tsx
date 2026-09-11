"use client"

import { useMemo, useState, useTransition } from "react"
import { IconArrowsJoin, IconPencil, IconPlus } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { createCategory, mergeCategory, renameCategory, type CategoryRow } from "@/lib/category-actions"

/**
 * Two levels, shown as two levels.
 *
 * A flat list with a "parent" column would let you read the taxonomy but not
 * see its shape, and the shape is the thing being managed. Children nest under
 * their parent; the event count sits on every row because it is what makes a
 * dead category visible.
 *
 * There is no delete. A category with events attached would drop those events
 * out of every filter on the mobile client, so retiring one is a merge — which
 * moves its events somewhere real first.
 */
export function CategoryManager({ categories }: { categories: CategoryRow[] }) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [merging, setMerging] = useState<CategoryRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [pending, start] = useTransition()

  const parents = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const childrenOf = useMemo(() => {
    const map = new Map<string, CategoryRow[]>()
    for (const c of categories) {
      if (!c.parentId) continue
      map.set(c.parentId, [...(map.get(c.parentId) ?? []), c])
    }
    return map
  }, [categories])

  const orphans = categories.filter((c) => c.parentId && !parents.some((p) => p.id === c.parentId))

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.8125rem] text-muted-foreground">
          Two levels: a parent like <b className="text-foreground">Sports</b> with children like{" "}
          <b className="text-foreground">IPL Streaming</b>. Filtering by a parent on the mobile app
          matches its children too.
        </p>
        <Button size="sm" onClick={() => setCreating((c) => !c)}>
          <IconPlus className="size-4" /> New category
        </Button>
      </div>

      {creating ? <CreateForm parents={parents} onDone={() => setCreating(false)} /> : null}

      {orphans.length > 0 ? (
        <p className="border-l-2 border-destructive pl-3 text-[0.8125rem]">
          {orphans.length} categor{orphans.length === 1 ? "y" : "ies"} point at a parent that no
          longer exists. They will not appear under any parent filter.
        </p>
      ) : null}

      <div className="flex flex-col gap-6">
        {parents.map((parent) => (
          <section key={parent.id} className="border-t border-border">
            <Row
              row={parent}
              isParent
              renaming={renaming === parent.id}
              onRename={() => setRenaming(parent.id)}
              onCancelRename={() => setRenaming(null)}
              onMerge={() => setMerging(parent)}
              pending={pending}
              start={start}
            />
            {(childrenOf.get(parent.id) ?? []).map((child) => (
              <Row
                key={child.id}
                row={child}
                renaming={renaming === child.id}
                onRename={() => setRenaming(child.id)}
                onCancelRename={() => setRenaming(null)}
                onMerge={() => setMerging(child)}
                pending={pending}
                start={start}
              />
            ))}
          </section>
        ))}
      </div>

      {merging ? (
        <MergeForm
          from={merging}
          options={categories.filter((c) => c.id !== merging.id && !c.parentId === !merging.parentId)}
          onDone={() => setMerging(null)}
        />
      ) : null}
    </div>
  )
}

function Row({
  row,
  isParent,
  renaming,
  onRename,
  onCancelRename,
  onMerge,
  pending,
  start,
}: {
  row: CategoryRow
  isParent?: boolean
  renaming: boolean
  onRename: () => void
  onCancelRename: () => void
  onMerge: () => void
  pending: boolean
  start: React.TransitionStartFunction
}) {
  const [name, setName] = useState(row.name)

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-b border-border py-2 last:border-0",
        !isParent && "pl-6"
      )}
    >
      {renaming ? (
        <>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-64 text-[0.8125rem]"
            autoFocus
          />
          <Button
            size="sm"
            disabled={pending || name.trim().length < 2}
            onClick={() =>
              start(async () => {
                try {
                  await renameCategory(row.id, name)
                  toast.success("Renamed")
                  onCancelRename()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not rename")
                }
              })
            }
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelRename} disabled={pending}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className={cn("flex-1 text-sm", isParent && "text-[0.9375rem] font-bold")}>{row.name}</span>
          <code className="text-[0.6875rem] text-faint-foreground">{row.slug}</code>
          {/*
            Interests sit beside events because they are what matching ranks
            on. A category with no events and four hundred interests looks dead
            by the event count alone, and retiring it used to destroy all four
            hundred. Plain text, tabular — seventy rows of chips was a wall.
          */}
          <span
            className={cn(
              "w-40 text-right text-[0.75rem] tabular-nums",
              row.eventCount === 0 && row.interestCount === 0
                ? "text-faint-foreground"
                : "text-muted-foreground"
            )}
          >
            {row.eventCount} event{row.eventCount === 1 ? "" : "s"} · {row.interestCount} interest
            {row.interestCount === 1 ? "" : "s"}
          </span>
          <Button size="sm" variant="ghost" onClick={onRename} aria-label={`Rename ${row.name}`}>
            <IconPencil className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onMerge} aria-label={`Merge ${row.name}`}>
            <IconArrowsJoin className="size-4" />
          </Button>
        </>
      )}
    </div>
  )
}

function CreateForm({ parents, onDone }: { parents: CategoryRow[]; onDone: () => void }) {
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState("none")
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-wrap items-end gap-2 border-l-2 border-border-strong pl-3">
      <div className="flex flex-1 flex-col gap-1.5">
        <label className="text-[0.75rem] text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="IPL Streaming" className="h-9" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[0.75rem] text-muted-foreground">Parent</label>
        <Select value={parentId} onValueChange={setParentId}>
          <SelectTrigger size="sm" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Top level</SelectItem>
            {parents.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        disabled={pending || name.trim().length < 2}
        onClick={() =>
          start(async () => {
            try {
              await createCategory(name, parentId === "none" ? null : parentId)
              toast.success("Category created")
              setName("")
              onDone()
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Could not create")
            }
          })
        }
      >
        Create
      </Button>
      <Button variant="ghost" onClick={onDone} disabled={pending}>
        Cancel
      </Button>
    </div>
  )
}

function MergeForm({
  from,
  options,
  onDone,
}: {
  from: CategoryRow
  options: CategoryRow[]
  onDone: () => void
}) {
  const [intoId, setIntoId] = useState("")
  const [pending, start] = useTransition()
  const into = options.find((o) => o.id === intoId)

  return (
    <div className="flex flex-col gap-3 border-l-2 border-warning pl-3">
      <p className="text-[0.8125rem] leading-6">
        Merge <b>{from.name}</b> into another category. Its {from.eventCount} event
        {from.eventCount === 1 ? "" : "s"} and {from.interestCount} saved interest
        {from.interestCount === 1 ? "" : "s"} move across, and <b>{from.name}</b> is deleted. There
        is no delete without a merge, because a category removed on its own drops its events out of
        every filter on the app — and took everyone&rsquo;s saved interest in it with them.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={intoId} onValueChange={setIntoId}>
          <SelectTrigger size="sm" className="w-64">
            <SelectValue placeholder="Merge into…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.parentName ? `${o.parentName} → ${o.name}` : o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending || !intoId}
          onClick={() =>
            start(async () => {
              try {
                const moved = await mergeCategory(from.id, intoId)
                // Both numbers, because the interests are the half that used to
                // be destroyed and the admin never saw them mentioned at all.
                const parts = [`${moved.events} event${moved.events === 1 ? "" : "s"}`]
                if (moved.interests > 0) {
                  parts.push(
                    `${moved.interests} interest${moved.interests === 1 ? "" : "s"}`
                  )
                }
                toast.success(`Merged into ${into?.name} · ${parts.join(", ")} moved`)
                onDone()
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not merge")
              }
            })
          }
        >
          Merge and delete {from.name}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
