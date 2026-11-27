// Confidence thresholds for moderation actions
export const AUTO_HIDE_THRESHOLD = 0.7
export const FLAG_THRESHOLD = 0.4

// Spam detection
export const SPAM_BURST_LIMIT = 5
export const SPAM_BURST_WINDOW_MS = 10_000 // 10 seconds
export const SPAM_DUPLICATE_SIMILARITY = 0.8
export const SPAM_HISTORY_TTL_MS = 5 * 60 * 1000 // 5 minutes
export const SPAM_MAX_ENTRIES = 5_000
export const MAX_LINKS_PER_MESSAGE = 2

// Auto-mute: triggered after N hidden abusive messages (contact details do not count, SCRUM-485) in a time window
export const AUTO_MUTE_HIDDEN_COUNT = 3
export const AUTO_MUTE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

/**
 * The key `recordHide` adds to a hidden line's flag until the model has judged
 * the line. It never counts toward a mute (`abuseHiddenCount`); the staff alert
 * says such lines on their own line (`lib/staff-alert.ts`).
 */
export const UNJUDGED_KEY = "unjudged"
/** A flag's categories as a screen, an export or an API response shows them: without `UNJUDGED_KEY`. */
export function displayCategories<T>(categories: T): T {
  if (!categories || typeof categories !== "object" || Array.isArray(categories) || !(UNJUDGED_KEY in categories)) return categories
  return Object.fromEntries(Object.entries(categories).filter(([key]) => key !== UNJUDGED_KEY)) as T
}
/** Category keys (OpenAI's, and their sub-keys) that make a pending flag severe at any confidence (`lib/staff-alert.ts`). */
export const SEVERE_CATEGORY_PREFIXES = ["violence", "self-harm", "sexual/minors", "harassment/threatening"]
