"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ISSUE_CATEGORIES } from "@/lib/sentiment/taxonomy"
import { cn } from "@/lib/utils"

import { correctFeedbackLabel, type FeedbackMessage } from "./actions"

const SENTIMENTS: feedback_sentiment[] = ["positive", "neutral", "negative"]

/** Below this the label is a guess and must not look like a judgement. */
const UNSURE = 0.7

function toneClass(sentiment: feedback_sentiment) {
  return sentiment === "positive"
    ? "text-success"
    : sentiment === "negative"
      ? "text-destructive"
      : "text-muted-foreground"
}

/**
 * The message feed, with every label correctable in place.
 *
 * Correcting is one click to open, one to choose — not a modal. It is expected
 * to happen often: the classifier misses sarcasm, and "great, only queued 40
 * minutes" is a routine case rather than an edge one. Friction here means
 * hosts stop correcting and the digest quietly drifts from the truth.
 */
export function FeedbackFeed({ messages }: { messages: FeedbackMessage[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)

  const correct = (
    id: string,
    sentiment: feedback_sentiment,
    category: issue_category
  ) => {
    setActing(id)
    startTransition(async () => {
      try {
        await correctFeedbackLabel(id, sentiment, category)
        toast.success("Label corrected")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not correct the label")
      } finally {
        setActing(null)
      }
    })
  }

  if (messages.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Nothing classified yet. What people say while still outside the venue lands here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {messages.map((m) => (
          <li key={m.id} className="flex flex-col gap-1 py-3 first:pt-0">
            <span className="flex flex-wrap items-center gap-2 text-[0.75rem] text-muted-foreground">
              {/*
                * Suppressed messages keep their label and lose their author.
                *
                * The organiser still learns that somebody raised this, in this
                * category — which is the actionable half — without learning
                * who. Below the disclosure floor the pseudonym is as
                * identifying as a name, because it is stable for the whole
                * room and they have seen it all night.
                */}
              <b className="font-medium text-foreground">
                {m.suppressed ? "Someone" : m.pseudonym}
              </b>
              {m.at ? (
                <span>
                  {new Date(m.at).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    disabled={pending && acting === m.id}
                    className={cn(
                      "min-h-6 rounded-full border border-border px-2 py-0.5 text-[0.6875rem] font-medium transition-colors hover:bg-accent",
                      toneClass(m.sentiment)
                    )}
                  >
                    {m.sentiment} · {m.category.replace(/_/g, " ")}
                    {/* A low-confidence label is a guess. Saying so is the
                        difference between a host trusting the digest and a
                        host being misled by it. */}
                    {!m.corrected && m.confidence < UNSURE ? (
                      <span className="ml-1 text-faint-foreground">· unsure</span>
                    ) : null}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
                  <DropdownMenuLabel className="text-[0.75rem]">Sentiment</DropdownMenuLabel>
                  {SENTIMENTS.map((s) => (
                    <DropdownMenuItem key={s} onClick={() => correct(m.id, s, m.category)}>
                      {s}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuLabel className="mt-1 text-[0.75rem]">Category</DropdownMenuLabel>
                  {ISSUE_CATEGORIES.map((c) => (
                    <DropdownMenuItem key={c} onClick={() => correct(m.id, m.sentiment, c)}>
                      {c.replace(/_/g, " ")}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {m.corrected ? (
                <Badge variant="secondary" className="text-[0.6875rem]">
                  corrected
                </Badge>
              ) : null}
            </span>
            {m.suppressed ? (
              <span className="text-sm leading-relaxed text-muted-foreground">
                Held back — too few people raised this for the message to be
                shown without identifying them.
              </span>
            ) : (
              <span className="text-sm leading-relaxed">{m.text}</span>
            )}
          </li>
        ))}
      </ul>

      <p className="max-w-[70ch] border-t border-border pt-3 text-[0.75rem] text-faint-foreground">
        Names are pseudonyms, enforced server-side. Small categories are held back
        entirely — a stable pseudonym in a small room is a name.
      </p>
    </div>
  )
}
