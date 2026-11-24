import type { DisclosedTopic } from "@/lib/disclosure"
import { formatNumber } from "@/lib/dashboard-format"
import type { FeedbackTopic } from "@/lib/sentiment/taxonomy"

/** The five labels in words (Fable advisor, 2026-11-24): the same on a concert and a meetup. */
const LABELS: Record<FeedbackTopic, string> = {
  people: "meeting people",
  music: "the music",
  program: "the program",
  food_drink: "food and drink",
  place: "the place",
}

/**
 * "Talking about" (SCRUM-1101, boards live-A and post-A): what the positive
 * messages liked, by how many people. Labels, never a word anybody wrote; a
 * label under five people is not sent at all.
 */
export function TalkingAbout({ topics, live }: { topics: DisclosedTopic[]; live?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">Talking about</h3>
        <span className="text-[0.75rem] text-faint-foreground">{live ? "positive · last 30 min" : "positive messages"}</span>
      </div>
      {topics.length === 0 ? (
        <p className="text-[0.78rem] text-muted-foreground">{live ? "No topic has 5 people behind it yet." : "No topic has 5 people behind it."}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {topics.map((t) => (
            <li key={t.topic} className="rounded-full border border-border-strong px-2.5 py-0.5 text-[0.75rem] font-medium tabular-nums">
              {LABELS[t.topic as FeedbackTopic] ?? t.topic} · {formatNumber(t.people)}
              <span className="sr-only"> people</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
