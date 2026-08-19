"use client"

import { useState, useTransition } from "react"
import { IconPlus, IconX } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { SPONSORSHIP } from "@/lib/constants"
import { createPoll } from "@/lib/poll-actions"

const MAX_OPTIONS = 6

/**
 * Post a poll into the room.
 *
 * The results switch defaults off and says what it costs, because the default is
 * the safe one and the exception is the one that needs justifying: a running
 * total biases later voters, and in a small room the first vote landing is
 * visible to everyone watching.
 */
export function PollComposer({ eventId }: { eventId: string }) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState("")
  const [options, setOptions] = useState(["", ""])
  const [resultsVisible, setResultsVisible] = useState(false)
  const [pending, start] = useTransition()

  const filled = options.map((o) => o.trim()).filter(Boolean)
  const ready = question.trim().length >= 3 && filled.length >= 2

  function reset() {
    setQuestion("")
    setOptions(["", ""])
    setResultsVisible(false)
    setOpen(false)
  }

  function post() {
    start(async () => {
      try {
        await createPoll(eventId, {
          question,
          options: filled,
          resultsVisible,
        })
        toast.success("Poll posted")
        reset()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not post that poll")
      }
    })
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <IconPlus className="size-4 mr-1" />
        Poll
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="poll-question">Question</Label>
        <Textarea
          id="poll-question"
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How is the music?"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Options</Label>
        {options.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={value}
              onChange={(e) =>
                setOptions((prev) => prev.map((o, j) => (i === j ? e.target.value : o)))
              }
              placeholder={`Option ${i + 1}`}
            />
            {options.length > 2 ? (
              <Button
                size="icon"
                variant="ghost"
                className="size-9 shrink-0"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
              >
                <IconX className="size-4" />
              </Button>
            ) : null}
          </div>
        ))}
        {options.length < MAX_OPTIONS ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => setOptions((prev) => [...prev, ""])}
          >
            <IconPlus className="size-4 mr-1" />
            Add option
          </Button>
        ) : (
          // Six is the cap in the schema too. Said here rather than silently
          // hiding the button, which reads as a broken control.
          <p className="text-[0.75rem] text-muted-foreground">
            Six options is the most a phone can read at a glance.
          </p>
        )}
      </div>

      <div className="flex items-start justify-between gap-3 rounded-md border bg-background p-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[0.8125rem] font-medium">Show results while it is open</span>
          <span className="text-[0.75rem] leading-5 text-muted-foreground">
            Off by default. A running total pushes later voters toward whatever is
            already winning, and in a small room the first vote landing is visible
            to everyone watching. Either way, counts stay hidden until at least{" "}
            {SPONSORSHIP.MIN_REPORTABLE} people have voted.
          </span>
        </div>
        <Switch
          checked={resultsVisible}
          onCheckedChange={setResultsVisible}
          aria-label="Show results while the poll is open"
        />
      </div>

      <p className="text-[0.75rem] text-muted-foreground">
        Closes when the event ends.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !ready} onClick={post}>
          Post poll
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
