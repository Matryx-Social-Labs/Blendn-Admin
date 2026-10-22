export type ModerationAction = "allow" | "flag" | "hide"

export interface ModerationResult {
  action: ModerationAction
  source: "keyword" | "openai_text" | "openai_image" | "spam"
  categories: Record<string, number>
  confidence: number
  matched?: string[] // for keyword filter
  reason?: string // for spam detector
  /** Seconds until the burst window ends and a send can go through. Burst blocks only (SV13). */
  retryAfter?: number
}

export interface OpenAIModerationCategory {
  hate: number
  "hate/threatening": number
  harassment: number
  "harassment/threatening": number
  "self-harm": number
  "self-harm/intent": number
  "self-harm/instructions": number
  sexual: number
  "sexual/minors": number
  violence: number
  "violence/graphic": number
}
