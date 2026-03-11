// Confidence thresholds for moderation actions
export const AUTO_HIDE_THRESHOLD = 0.85
export const FLAG_THRESHOLD = 0.5

// Spam detection
export const SPAM_BURST_LIMIT = 5
export const SPAM_BURST_WINDOW_MS = 10_000 // 10 seconds
export const SPAM_DUPLICATE_SIMILARITY = 0.8
export const SPAM_HISTORY_TTL_MS = 5 * 60 * 1000 // 5 minutes
export const SPAM_MAX_ENTRIES = 5_000
export const MAX_LINKS_PER_MESSAGE = 2

// Auto-mute: triggered after N hidden messages in a time window
export const AUTO_MUTE_HIDDEN_COUNT = 3
export const AUTO_MUTE_WINDOW_MS = 60 * 60 * 1000 // 1 hour
