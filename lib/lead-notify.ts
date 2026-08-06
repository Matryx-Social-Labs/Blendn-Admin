import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { appUrl, emailConfigured, sendEmail } from "@/lib/email"

/**
 * Telling someone a lead arrived.
 *
 * A `new` row nobody knows about is worth exactly as much as the Supabase table
 * nobody read. A demo request is a person asking for a sales conversation, so
 * it goes out immediately rather than into a digest — response time is the
 * whole game.
 *
 * **Email, not Slack.** The contract offers either; this codebase already sends
 * transactional mail through Resend (`lib/email.ts`) and has no Slack
 * integration at all. Adding a webhook, a secret and a retry path to save one
 * hop is not worth it while `LEADS_NOTIFY_EMAIL` reaches the same people.
 * If ops moves to Slack, this is the one function to change.
 *
 * Unconfigured is a first-class state, as everywhere else here: no
 * `LEADS_NOTIFY_EMAIL` means no notification and an info log, never a throw.
 * The lead is already stored by the time this runs, and losing the alert must
 * not turn a successful ingest into a 5xx the visitor sees as failure.
 */
export async function notifyNewLead(leadId: string): Promise<void> {
  const to = process.env.LEADS_NOTIFY_EMAIL
  if (!to || !emailConfigured()) {
    logger.info("Lead notification skipped — LEADS_NOTIFY_EMAIL/Resend unset", { leadId })
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

  const who = lead.name || lead.email
  const org = lead.organization ? ` (${lead.organization})` : ""
  const link = `${appUrl()}/dashboard/leads?lead=${lead.id}`

  const lines = [
    `${who}${org} asked for a demo.`,
    "",
    `Email:       ${lead.email}`,
    lead.city ? `City:        ${lead.city}` : null,
    lead.event_types ? `Runs:        ${lead.event_types}` : null,
    `Source:      ${lead.source}`,
    application
      ? `Already applied — application status: ${application.status}`
      : "No application from this address yet.",
    "",
    link,
  ].filter(Boolean)

  await sendEmail({
    to,
    subject: `Demo request — ${who}${org}`,
    text: lines.join("\n"),
  })
}
