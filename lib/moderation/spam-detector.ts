import type { ModerationResult } from "./types"
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

// In-memory store keyed by "userId:chatGroupId"
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
 * 1. Burst rate (too many messages in a short window)
 * 2. Duplicate/near-duplicate content
 * 3. Excessive links
 */
export function checkSpam(
  userId: string,
  chatGroupId: string,
  content: string
): ModerationResult | null {
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

  // --- Check 2: Burst rate ---
  if (history.messages.length >= SPAM_BURST_LIMIT) {
    history.messages.push({ content: normalizedContent, timestamp: now })
    return {
      action: "hide",
      source: "spam",
      categories: { spam: 0.95 },
      confidence: 0.95,
      reason: `Burst rate exceeded (${history.messages.length} messages in ${SPAM_BURST_WINDOW_MS / 1000}s)`,
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

/** Reset history for a user in a chat group (useful for testing) */
export function resetSpamHistory(userId: string, chatGroupId: string): void {
  historyMap.delete(`${userId}:${chatGroupId}`)
}

/** Clear all spam history (useful for testing) */
export function clearAllSpamHistory(): void {
  historyMap.clear()
}
