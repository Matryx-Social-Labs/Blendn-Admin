import type { ModerationResult } from "./types"
import { hit, forget } from "@/lib/rate-limit-store"
import {
  SPAM_BURST_LIMIT,
  SPAM_BURST_WINDOW_MS,
  SPAM_DUPLICATE_SIMILARITY,
  SPAM_HISTORY_TTL_MS,
  SPAM_MAX_ENTRIES,
  MAX_LINKS_PER_MESSAGE,
} from "./config"

interface MessageEntry {
  content: string
  timestamp: number
}

interface UserHistory {
  messages: MessageEntry[]
  lastCleanup: number
}

/**
 * Recent message *content*, keyed by "userId:chatGroupId". In process, per
 * replica.
 *
 * ## Why the burst counter left and this did not
 *
 * Both halves used to live here, and the rate limiter was moved to Redis for
 * exactly the reason that made that wrong: a limit enforced per replica gets
 * weaker with every instance you add. Burst detection is a counter, so it now
 * goes through `lib/rate-limit-store.ts` -- the same fixed-window primitive,
 * shared, with the same degrade-to-memory behaviour when Redis is absent.
 *
 * Near-duplicate detection needs the previous messages themselves, to run a
 * trigram similarity against them. That is a message store with a TTL, not a
 * counter, and it is more machinery than the problem currently justifies:
 * Socket.io needs sticky sessions, so one person's messages mostly land on one
 * replica, and the case this misses is somebody deliberately reconnecting
 * between each repeat. Burst catches that anyway.
 *
 * Recorded rather than fixed, deliberately. It is a real per-replica gap and it
 * should be named as one instead of looking like an oversight.
 */
const historyMap = new Map<string, UserHistory>()

/** Evict stale entries to bound memory usage */
function evictStaleEntries(): void {
  if (historyMap.size <= SPAM_MAX_ENTRIES) return
  const now = Date.now()
  for (const [key, history] of historyMap) {
    if (now - history.lastCleanup > SPAM_HISTORY_TTL_MS) {
      historyMap.delete(key)
    }
  }
}

/** Simple trigram-based similarity (0–1) */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 3 || b.length < 3) return a === b ? 1 : 0

  const trigramsA = new Set<string>()
  const trigramsB = new Set<string>()
  for (let i = 0; i <= a.length - 3; i++) trigramsA.add(a.slice(i, i + 3))
  for (let i = 0; i <= b.length - 3; i++) trigramsB.add(b.slice(i, i + 3))

  let intersection = 0
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++
  }

  const union = trigramsA.size + trigramsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Count URLs in message content */
function countLinks(content: string): number {
  const urlPattern = /https?:\/\/[^\s]+/gi
  const matches = content.match(urlPattern)
  return matches ? matches.length : 0
}

/**
 * Check if a message is spam based on:
 * 1. Excessive links
 * 2. Burst rate (too many messages in a short window) -- shared across replicas
 * 3. Duplicate/near-duplicate content -- per replica, see `historyMap`
 *
 * Async because the burst counter lives in Redis when one is configured.
 */
export async function checkSpam(
  userId: string,
  chatGroupId: string,
  content: string
): Promise<ModerationResult | null> {
  const key = `${userId}:${chatGroupId}`
  const now = Date.now()
  const normalizedContent = content.toLowerCase().trim()

  // Get or create history
  let history = historyMap.get(key)
  if (!history) {
    history = { messages: [], lastCleanup: now }
    historyMap.set(key, history)
  }

  // Prune messages older than the burst window
  history.messages = history.messages.filter(
    (m) => now - m.timestamp < SPAM_BURST_WINDOW_MS
  )
  history.lastCleanup = now

  // --- Check 1: Link density ---
  const linkCount = countLinks(content)
  if (linkCount > MAX_LINKS_PER_MESSAGE) {
    // Record this message but return spam result
    history.messages.push({ content: normalizedContent, timestamp: now })
    return {
      action: "hide",
      source: "spam",
      categories: { spam: 0.9 },
      confidence: 0.9,
      reason: `Too many links (${linkCount})`,
    }
  }

  /*
   * --- Check 2: Burst rate ---
   *
   * Counted in the shared store rather than off `history.messages`, so the
   * limit is one bucket for the account instead of one per replica. Somebody
   * flooding a room across four instances was previously allowed four times the
   * burst.
   */
  const { count } = await hit(`spam:burst:${key}`, SPAM_BURST_WINDOW_MS)
  if (count > SPAM_BURST_LIMIT) {
    history.messages.push({ content: normalizedContent, timestamp: now })
    return {
      action: "hide",
      source: "spam",
      categories: { spam: 0.95 },
      confidence: 0.95,
      reason: `Burst rate exceeded (${count} messages in ${SPAM_BURST_WINDOW_MS / 1000}s)`,
    }
  }

  // --- Check 3: Duplicate content ---
  for (const prev of history.messages) {
    if (similarity(normalizedContent, prev.content) >= SPAM_DUPLICATE_SIMILARITY) {
      history.messages.push({ content: normalizedContent, timestamp: now })
      return {
        action: "flag",
        source: "spam",
        categories: { spam: 0.7 },
        confidence: 0.7,
        reason: "Duplicate or near-duplicate message",
      }
    }
  }

  // Record this message for future checks
  history.messages.push({ content: normalizedContent, timestamp: now })

  // Periodic eviction
  evictStaleEntries()

  return null
}

/**
 * Reset everything this module remembers about a user in a chat group.
 *
 * Both halves. The burst counter lives in the shared store now, and a reset
 * that cleared only the local Map would leave the window running -- which is
 * not a test-only problem: it would mean the counter and the history could
 * disagree about whether this person has said anything recently.
 */
export async function resetSpamHistory(userId: string, chatGroupId: string): Promise<void> {
  const key = `${userId}:${chatGroupId}`
  historyMap.delete(key)
  await forget(`spam:burst:${key}`)
}

/** Clear all spam history (useful for testing) */
export async function clearAllSpamHistory(): Promise<void> {
  // Both halves, for the same reason `resetSpamHistory` does: clearing the Map
  // alone leaves every burst window running, and the next caller inherits it.
  await Promise.all([...historyMap.keys()].map((key) => forget(`spam:burst:${key}`)))
  historyMap.clear()
}
