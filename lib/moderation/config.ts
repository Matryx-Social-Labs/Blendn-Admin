// Confidence thresholds for moderation actions
export const AUTO_HIDE_THRESHOLD = 0.7
export const FLAG_THRESHOLD = 0.4
/**
 * An IMAGE whose `sexual/minors` score reaches this is a hide naming that
 * category, whatever its other scores (SCRUM-1163). Folded into the max it was
 * at most a flag, which profile and blur photos drop. Images only: text keeps
 * the two thresholds above.
 */
export const CHILD_SAFETY_IMAGE_THRESHOLD = 0.2
export const CHILD_SAFETY_CATEGORY = "sexual/minors"

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
