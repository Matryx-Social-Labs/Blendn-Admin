// Relative imports: reachable from server.ts (background.ts -> staff-alert.ts),
// which `build:server` compiles with plain tsc.
import { emailConfigured, sendEmail } from "./email"
import { logger } from "./logger"

/**
 * Telling the team something, over the free channels: a Slack (or
 * Discord-compatible) incoming webhook, an email address, both, or neither.
 * Used by the lead alert (`lead-notify.ts`) and the staff alert (`staff-alert.ts`).
 *
 * Unconfigured is a first-class state: `channelsFrom` returns null and the
 * caller logs at info. Both channels are attempted even if the first fails —
 * a Slack outage should not also cost you the email — and nothing here throws.
 *
 * The webhook URL is a bearer secret: anyone holding it can post to that
 * channel. It lives in Railway env vars and is never logged, nor put in an
 * error: a failing post is reported by status or error name only.
 */
export interface Channels {
  slackUrl?: string
  emailTo?: string
}

/** The channels two env vars name, or null when neither can deliver (an address without Resend cannot). */
export function channelsFrom(slackVar: string, emailVar: string): Channels | null {
  const slackUrl = process.env[slackVar] || undefined
  const email = process.env[emailVar]
  const emailTo = email && emailConfigured() ? email : undefined
  return slackUrl || emailTo ? { slackUrl, emailTo } : null
}

export interface ChannelMessage {
  subject: string
  text: string
  /** The webhook body; `{ text }` when omitted. Keep a `text` in it: Discord and phone previews read that. */
  slack?: Record<string, unknown>
}

/** Whether at least one channel took the message. Settled, not raced: one failing channel must not cancel the other. */
export async function sendToChannels(
  channels: Channels,
  message: ChannelMessage,
  context: Record<string, unknown>
): Promise<boolean> {
  const sends: Promise<void>[] = []
  if (channels.slackUrl) sends.push(postToWebhook(channels.slackUrl, message.slack ?? { text: message.text }))
  if (channels.emailTo) sends.push(email(channels.emailTo, message))
  let delivered = false
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === "fulfilled") delivered = true
    else logger.error("Notification channel failed", { ...context, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  }
  return delivered
}

async function postToWebhook(url: string, body: Record<string, unknown>): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // A hanging webhook must not hold the caller open.
      signal: AbortSignal.timeout(8_000),
    })
  } catch (error) {
    // The error's own message can quote the URL ("Failed to parse URL from …"): the name only.
    throw new Error(`Webhook unreachable (${error instanceof Error ? error.name : "unknown"})`)
  }
  // The status only: a webhook's reply body is the far side's text, and may echo the request.
  if (!res.ok) throw new Error(`Webhook ${res.status}`)
}

async function email(to: string, message: ChannelMessage): Promise<void> {
  const result = await sendEmail({ to, subject: message.subject, text: message.text })
  if (!result.sent) throw new Error(`Email not sent (${result.reason ?? "unknown"})`)
}
