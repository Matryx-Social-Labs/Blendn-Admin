import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { appUrl } from "@/lib/email"
import { channelsFrom, sendToChannels } from "@/lib/notify-channels"

/**
 * Telling someone a lead arrived.
 *
 * A `new` row nobody knows about is worth exactly as much as the Supabase table
 * nobody read. A demo request is a person asking for a sales conversation, so
 * it goes out immediately rather than into a digest — response time is the
 * whole game.
 *
 * **Two channels, both optional, both free.** Slack incoming webhooks cost
 * nothing (no paid plan required); Resend's free tier covers this volume many
 * times over. Which one is right depends only on where the team actually looks,
 * so the code does not decide — set either env var, or both, or neither:
 *
 *   LEADS_SLACK_WEBHOOK_URL   a Slack (or Discord-compatible) incoming webhook
 *   LEADS_NOTIFY_EMAIL        an address or alias
 *
 * Unconfigured is a first-class state, as everywhere else here: nothing set
 * means an info log, never a throw. The lead is already stored by the time this
 * runs, and losing the alert must not turn a successful ingest into a 5xx the
 * visitor sees as failure.
 *
 * Both channels are attempted even if the first fails, for the same reason — a
 * Slack outage should not also cost you the email. The sending is
 * `lib/notify-channels.ts`, shared with the staff alert.
 */

interface LeadSummary {
  id: string
  email: string
  name: string | null
  organization: string | null
  city: string | null
  eventTypes: string | null
  source: string
  /** Whether this person has already applied for an account. */
  applicationStatus: string | null
  link: string
}

export async function notifyNewLead(leadId: string): Promise<void> {
  const channels = channelsFrom("LEADS_SLACK_WEBHOOK_URL", "LEADS_NOTIFY_EMAIL")
  if (!channels) {
    logger.info("Lead notification skipped — no channel configured", {
      leadId,
      hint: "set LEADS_SLACK_WEBHOOK_URL or LEADS_NOTIFY_EMAIL",
    })
    return
  }

  const lead = await db.leads.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      email: true,
      name: true,
      organization: true,
      city: true,
      event_types: true,
      source: true,
    },
  })
  if (!lead) return

  // Cross-referenced here rather than only in the drawer: knowing the person
  // already applied changes who picks the lead up and what they say first.
  const application = await db.organiser_onboarding_requests.findFirst({
    where: { contact_email: lead.email },
    select: { status: true },
  })

  const summary: LeadSummary = {
    id: lead.id,
    email: lead.email,
    name: lead.name,
    organization: lead.organization,
    city: lead.city,
    eventTypes: lead.event_types,
    source: lead.source,
    applicationStatus: application?.status ?? null,
    link: `${appUrl()}/dashboard/leads?lead=${lead.id}`,
  }

  const org = summary.organization ? ` (${summary.organization})` : ""
  await sendToChannels(
    channels,
    { subject: `Demo request — ${who(summary)}${org}`, text: emailText(summary), slack: slackBody(summary) },
    { leadId }
  )
}

function who(lead: LeadSummary): string {
  return lead.name || lead.email
}

/**
 * Slack incoming webhook.
 *
 * Block Kit rather than plain `text`, so the email is clickable and the
 * "already applied" answer is readable at a glance in a busy channel. Falls
 * back to `text` for any client that ignores blocks — Discord's Slack-compatible
 * endpoint, for one.
 */
function slackBody(lead: LeadSummary): Record<string, unknown> {
  const org = lead.organization ? ` · ${lead.organization}` : ""
  const facts = [
    lead.city ? `*City* ${lead.city}` : null,
    lead.eventTypes ? `*Runs* ${lead.eventTypes}` : null,
    `*Source* ${lead.source}`,
  ].filter(Boolean)

  const applied = lead.applicationStatus
    ? `:white_check_mark: Already applied — application is *${lead.applicationStatus}*`
    : ":new: No application from this address yet"

  // Plain text too — a notification that renders as "[no preview]" on a phone
  // defeats the point of sending it immediately.
  return {
    text: `Demo request — ${who(lead)}${org}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Demo request* — ${who(lead)}${org}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Email*\n${lead.email}` },
          ...facts.map((f) => ({ type: "mrkdwn", text: f! })),
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: applied }] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in dashboard" },
            url: lead.link,
            style: "primary",
          },
        ],
      },
    ],
  }
}

function emailText(lead: LeadSummary): string {
  const org = lead.organization ? ` (${lead.organization})` : ""
  return [
    `${who(lead)}${org} asked for a demo.`,
    "",
    `Email:       ${lead.email}`,
    lead.city ? `City:        ${lead.city}` : null,
    lead.eventTypes ? `Runs:        ${lead.eventTypes}` : null,
    `Source:      ${lead.source}`,
    lead.applicationStatus
      ? `Already applied — application status: ${lead.applicationStatus}`
      : "No application from this address yet.",
    "",
    lead.link,
  ]
    .filter(Boolean)
    .join("\n")
}
