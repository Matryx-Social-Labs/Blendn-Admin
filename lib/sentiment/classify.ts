import { logger } from "../logger"

import { classifyWithLexicon } from "./lexicon"
import {
  ISSUE_CATEGORIES,
  isIssueCategory,
  isSentiment,
  type Classification,
} from "./taxonomy"

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
/**
 * Sentiment needs a completion call. The moderation endpoint returns harm
 * categories, not polarity — `lib/moderation/openai-moderation.ts` is the
 * integration pattern to copy here, not the API to call.
 */
const MODEL = "gpt-4o-mini"
/** Big enough to amortise the call, small enough that one bad batch is cheap. */
export const BATCH_SIZE = 20

export interface MessageToClassify {
  id: string
  text: string
}

export interface ClassifiedMessage extends Classification {
  id: string
}

const SYSTEM_PROMPT = `You label short chat messages sent by attendees during or just after a live event (a gig, club night, meetup, or similar).

For each message return:
- sentiment: positive | neutral | negative — how the attendee feels about the event
- category: one of ${ISSUE_CATEGORIES.join(", ")}
- confidence: 0-1, your genuine certainty

Rules:
- Logistics chatter with no opinion ("anyone getting there early?") is neutral / other.
- Sarcasm and understatement are common. "great, only queued 40 minutes" is negative / entry_queue.
- safety_conduct covers harassment, threats, aggression, or someone unwell. Use it whenever the message describes one, even if the tone is calm — a composed report is still a report.
- Use "other" only when no category genuinely fits, not when you are unsure between two.
- Lower your confidence rather than guessing.

Respond with JSON: {"results":[{"id":"...","sentiment":"...","category":"...","confidence":0.0}]}`

function getApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY
}

/**
 * Tier 3. Classifies a batch in one call and returns only what it could parse.
 *
 * Anything missing from the response is left to the caller to fall back on,
 * rather than being defaulted to neutral here — a silent "neutral" for a
 * message the model never labelled is indistinguishable from a real neutral,
 * and would quietly flatten the digest.
 */
async function classifyBatchWithLlm(
  messages: MessageToClassify[]
): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>()
  const apiKey = getApiKey()
  if (!apiKey || messages.length === 0) return out

  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(
              messages.map((m) => ({ id: m.id, text: m.text.slice(0, 500) }))
            ),
          },
        ],
      }),
      // A classifier must never hold up the pipeline that feeds it.
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      logger.error("Sentiment classification failed", { status: res.status })
      return out
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = body.choices?.[0]?.message?.content
    if (!content) return out

    const parsed = JSON.parse(content) as {
      results?: Array<{
        id?: string
        sentiment?: string
        category?: string
        confidence?: number
      }>
    }

    for (const row of parsed.results ?? []) {
      // Validate rather than trust: a model returning a category outside the
      // taxonomy would otherwise write an unusable value straight to the
      // database and break every group-by that reads it.
      if (!row.id || !row.sentiment || !row.category) continue
      if (!isSentiment(row.sentiment) || !isIssueCategory(row.category)) {
        logger.warn("Sentiment classifier returned an out-of-taxonomy label", {
          sentiment: row.sentiment,
          category: row.category,
        })
        continue
      }
      out.set(row.id, {
        sentiment: row.sentiment,
        category: row.category,
        confidence: Math.max(0, Math.min(1, row.confidence ?? 0.5)),
        source: "llm",
      })
    }
  } catch (error) {
    logger.error("Sentiment classification threw", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return out
}

/**
 * Classify a set of messages through the tiers.
 *
 * Tier 2 (lexicon, free) labels what it is sure about. Everything else is
 * batched to tier 3. At ~500 messages an hour with most being logistics
 * chatter, this is single-digit API calls per hour for a busy event.
 *
 * **The client's own label is not an input.** The mobile app computes one
 * on-device for instant local feedback, but a patched client can send whatever
 * it likes — suppressing a negative or manufacturing an alert that pushes to
 * the organiser's phone. Hints are advisory in the UI and never authoritative
 * here.
 *
 * If tier 3 is unavailable — no API key, an outage, a timeout — messages it
 * would have handled come back with the lexicon's best guess at low confidence
 * and `source: "lexicon"`, never a confident wrong label. The UI is expected to
 * present low confidence differently, which is why the field exists.
 */
export async function classifyMessages(
  messages: MessageToClassify[]
): Promise<ClassifiedMessage[]> {
  const settled: ClassifiedMessage[] = []
  const escalate: MessageToClassify[] = []

  for (const message of messages) {
    const quick = classifyWithLexicon(message.text)
    if (quick) settled.push({ id: message.id, ...quick })
    else escalate.push(message)
  }

  for (let i = 0; i < escalate.length; i += BATCH_SIZE) {
    const batch = escalate.slice(i, i + BATCH_SIZE)
    const labelled = await classifyBatchWithLlm(batch)

    for (const message of batch) {
      const result = labelled.get(message.id)
      if (result) {
        settled.push({ id: message.id, ...result })
        continue
      }
      // Degraded path. Something is better than nothing here — an unlabelled
      // message vanishes from the digest entirely — but it must be visibly
      // uncertain rather than quietly wrong.
      settled.push({
        id: message.id,
        sentiment: "neutral",
        category: "other",
        confidence: 0.2,
        source: "lexicon",
      })
    }
  }

  return settled
}
