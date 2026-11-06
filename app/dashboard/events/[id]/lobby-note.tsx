"use client"

import { useId, useRef, useState } from "react"
import { IconLoader2 } from "@tabler/icons-react"

import { Callout, Panel } from "@/components/dashboard/kit"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { LobbyState } from "@/lib/board"
import { BOARD } from "@/lib/constants"
import { updatedAgo } from "@/lib/dashboard-format"
import { characters, cn } from "@/lib/utils"

const HOST_POST_MAX = BOARD.MAX_HOST_POST_LENGTH
/** The counter turns amber here: fifty characters left. */
const NEAR_FULL = HOST_POST_MAX - 50

export interface LobbyNoteProps {
  eventId: string
  /** The org's public name (`broadcastAuthorName`): what the app shows above the note. */
  host: string
  note: { body: string; updatedAt: string } | null
  state: LobbyState
  /** Doors and the close, already said on the event's clock (`lobbyMoment`). */
  doors: string
  closes: string
  /** The server's now, so "Updated 3 h ago" renders the same on both sides. */
  now: string
}

/** The note as typed, stopped at 500 characters counted as `char_length` counts them, never halving an emoji. */
export function fitNote(text: string): string {
  const chars = [...text]
  return chars.length > HOST_POST_MAX ? chars.slice(0, HOST_POST_MAX).join("") : text
}

export function counterTone(count: number): string {
  return count >= NEAR_FULL ? "font-medium text-warning" : "text-faint-foreground"
}

type Failure = "failed" | "closed" | "limited"

/** A refused save, by status: the Lobby closed (409), the write limit (429), or anything else. */
export function failureFor(status: number | null): Failure {
  if (status === 409) return "closed"
  if (status === 429) return "limited"
  return "failed"
}

const FAILURE: Record<Failure, { tone: "destructive" | "warning"; title: string; body: string }> = {
  failed: {
    tone: "destructive",
    title: "Couldn’t save the note.",
    body: "Your text is still here. Try again.",
  },
  closed: {
    tone: "warning",
    title: "The Lobby has closed.",
    body: "The note can’t change now.",
  },
  limited: {
    tone: "warning",
    title: "Too many changes in a minute.",
    body: "Wait a moment, then save again.",
  },
}

/**
 * The host's pinned Lobby note (SCRUM-1026; lobby-pin-20261106 mockup): one
 * plain-text note per event, shown in the app under the org's name, editable
 * until the Lobby closes. Beside it, the Lobby's clock — Open, Read-only from
 * doors, Closes a day after the end — with the next change the only bright
 * word. The API is `PUT|DELETE /api/events/:id/lobby-pin`, canEdit only, as
 * this tab is.
 */
export function LobbyNotePanel(props: LobbyNoteProps) {
  const { eventId, host, state, doors, closes } = props
  const [note, setNote] = useState(props.note)
  const [now, setNow] = useState(props.now)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [clearFailed, setClearFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()

  const closed = state === "closed"
  const showField = !closed && (editing || note === null)
  const count = characters(text.trim())

  const save = async () => {
    setPending(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/events/${eventId}/lobby-pin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      })
      if (!res.ok) {
        setFailure(failureFor(res.status))
        return
      }
      const { pinned } = (await res.json()) as { pinned: { body: string; updatedAt: string } }
      setNote({ body: pinned.body, updatedAt: pinned.updatedAt })
      setNow(new Date().toISOString())
      setEditing(false)
    } catch {
      // The network: the generic failure, with the text kept.
      setFailure("failed")
    } finally {
      setPending(false)
    }
  }

  const clear = async () => {
    setPending(true)
    setClearFailed(false)
    try {
      const res = await fetch(`/api/events/${eventId}/lobby-pin`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(String(res.status))
      setNote(null)
      setText("")
      dialog.current?.close()
    } catch {
      dialog.current?.close()
      setClearFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Panel
      title="Lobby note"
      hint="one pinned note at the top of the app’s Lobby"
      // The board's title and dialog leading (1.3); the kit's default is 1.5.
      className="[&_h2]:leading-[1.3]"
      bodyClassName="grid gap-7 pt-4 @2xl/main:grid-cols-[minmax(0,1fr)_300px] @2xl/main:items-start"
    >
      <div className="flex min-w-0 max-w-[680px] flex-col gap-3 leading-[1.45]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
          <span className="text-muted-foreground">Shown in the app as</span>
          <b className="font-bold [overflow-wrap:anywhere]">{host}</b>
          <Badge variant="outline" className="h-5 border-border-strong px-[7px] py-0 text-[0.6875rem] leading-none text-muted-foreground">
            Host
          </Badge>
        </p>

        {showField ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-note`} className="text-[0.8125rem] font-medium leading-[1.3] text-muted-foreground">
                {note ? "Note" : "What should everyone going know?"}
              </label>
              <Textarea
                id={`${id}-note`}
                rows={note ? 8 : 5}
                value={text}
                onChange={(e) => setText(fitNote(e.target.value))}
                aria-describedby={`${id}-help ${id}-count`}
                className="min-h-[132px] resize-y rounded-lg px-3 py-2.5 text-[0.9375rem] leading-[1.55] field-sizing-fixed [overflow-wrap:anywhere] md:text-[0.9375rem] dark:bg-white/[0.03]"
              />
              <div className="flex items-baseline justify-between gap-3">
                <span id={`${id}-help`} className="text-[0.75rem] text-faint-foreground">
                  Plain text; line breaks are kept. People who turned on host alerts get a push{note ? " when you save a change" : ""}.
                </span>
                <span id={`${id}-count`} className={cn("shrink-0 text-[0.75rem] tabular-nums", counterTone(count))}>
                  {count} / {HOST_POST_MAX}
                </span>
              </div>
            </div>
            {failure ? (
              <Callout tone={FAILURE[failure].tone} title={FAILURE[failure].title} role="alert">
                {FAILURE[failure].body}
              </Callout>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button className="px-3.5 font-bold pointer-coarse:h-11" disabled={pending || count === 0} onClick={save}>
                {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
                {note ? "Save" : "Pin to the Lobby"}
              </Button>
              {note ? (
                <Button
                  variant="outline"
                  className="px-3.5 pointer-coarse:h-11"
                  onClick={() => {
                    setEditing(false)
                    setFailure(null)
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </>
        ) : note ? (
          <>
            <p className={cn("m-0 text-[0.9375rem] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]", closed && "text-faint-foreground")}>
              {note.body}
            </p>
            <p className="flex flex-wrap gap-1.5 text-[0.75rem] text-faint-foreground">
              {closed ? (
                <span>The Lobby closed {closes}. Nobody sees this note in the app now.</span>
              ) : (
                <>
                  <span>Updated {updatedAgo(note.updatedAt, now)}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">
                    {characters(note.body)} / {HOST_POST_MAX}
                  </span>
                </>
              )}
            </p>
            {clearFailed ? (
              <Callout tone="destructive" title="Couldn’t clear the note." role="alert">
                It is still in the Lobby. Try again.
              </Callout>
            ) : null}
            {closed ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  className="px-3.5 pointer-coarse:h-11"
                  onClick={() => {
                    setText(note.body)
                    setFailure(null)
                    setClearFailed(false)
                    setEditing(true)
                  }}
                >
                  Edit note
                </Button>
                <button type="button" className="text-[0.9375rem] text-destructive pointer-coarse:min-h-11" onClick={() => dialog.current?.showModal()}>
                  Clear<span className="sr-only"> the Lobby note</span>
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="text-[0.75rem] text-faint-foreground">Nothing was pinned. The Lobby closed {closes}.</p>
        )}
      </div>

      <LobbyClock state={state} doors={doors} closes={closes} />

      {closed || !note ? null : (
        <dialog
          ref={dialog}
          role="alertdialog"
          aria-labelledby={`${id}-clear`}
          aria-describedby={`${id}-clear-d`}
          className="m-auto w-[460px] max-w-[calc(100vw-2rem)] rounded-panel border border-border-strong bg-card p-[22px] text-left text-foreground backdrop:bg-black/60"
        >
          <div className="flex flex-col gap-3">
            <h2 id={`${id}-clear`} className="text-[1.0625rem] font-bold">
              Clear the Lobby note?
            </h2>
            <p id={`${id}-clear-d`} className="text-sm leading-[1.55] text-muted-foreground">
              It comes off the Lobby, and off the room’s From the Lobby card, right away. Nobody is told.
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="outline" autoFocus onClick={() => dialog.current?.close()}>
                Keep
              </Button>
              <Button variant="destructive" className="font-bold" disabled={pending} onClick={clear}>
                {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
                Clear
              </Button>
            </div>
          </div>
        </dialog>
      )}
    </Panel>
  )
}

type Step = "done" | "now" | "next"

/** The memorable detail: Open, Read-only, Closes on one rail; the next change is the only bright word. */
function LobbyClock({ state, doors, closes }: { state: LobbyState; doors: string; closes: string }) {
  const at = { open: 0, read_only: 1, closed: 3 }[state]
  const step = (i: number): Step => (i < at ? "done" : i === at ? "now" : "next")
  const items = [
    {
      k: "Open",
      v: state === "open" ? "Now" : `Until ${doors}`,
      d: "People going post, ask and reply. Your note is pinned first.",
    },
    {
      k: "Read-only",
      v: `From ${doors}`,
      d: "Doors: check-in opens and the room opens. Your note heads the room’s From the Lobby card.",
    },
    { k: "Closes", v: closes, d: "The Lobby and the room leave the app." },
  ]
  return (
    <ol
      aria-label="The Lobby’s clock"
      className="relative m-0 flex list-none flex-col gap-4 p-0 pl-[18px] before:absolute before:top-1.5 before:bottom-1.5 before:left-1 before:w-0.5 before:rounded-[1px] before:bg-surface-raised"
    >
      {items.map((item, i) => {
        const s = step(i)
        return (
          <li
            key={item.k}
            aria-current={s === "now" ? "step" : undefined}
            className={cn(
              "relative flex flex-col gap-px before:absolute before:top-1 before:-left-[18px] before:size-2.5 before:rounded-full before:bg-surface-raised before:shadow-[0_0_0_3px_var(--card)]",
              s === "done" && "before:bg-muted-foreground",
              s === "now" && "before:bg-foreground",
            )}
          >
            <span
              className={cn(
                "text-[0.75rem] font-medium leading-[1.3] tracking-[0.06em] uppercase",
                s === "now" ? "text-foreground" : "text-faint-foreground",
              )}
            >
              {item.k}
            </span>
            <span className={cn("text-[0.9375rem] font-bold leading-[1.35] tabular-nums", i === at + 1 && "text-primary")}>{item.v}</span>
            <span className="text-[0.8125rem] leading-[1.45] text-muted-foreground">{item.d}</span>
          </li>
        )
      })}
    </ol>
  )
}
