"use server"

import { revalidatePath } from "next/cache"
import type { lead_status } from "@prisma/client"

import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { CLOSED_LEAD_STATUSES, openKey, openKeyFor } from "@/lib/leads"

/**
 * Working a lead.
 *
 * The endpoint half of this feature is worthless on its own — an endpoint that
 * stores leads nobody looks at is the Supabase table nobody read, with extra
 * steps. This is the half that gets them contacted.
 *
 * Admin-only throughout. A lead carries a stranger's name, email, IP and user
 * agent; it is marketing PII, and organisers have no business in it.
 */

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  return session.user
}

/** Statuses reachable from each status. Enforced server-side, not just in the UI. */
const TRANSITIONS: Record<lead_status, lead_status[]> = {
  new: ["contacted", "archived", "spam"],
  contacted: ["qualified", "archived", "spam"],
  qualified: ["converted", "archived", "spam"],
  // Terminal states can still be archived or reopened to contacted — a lead
  // marked spam by mistake must be recoverable.
  converted: ["archived"],
  archived: ["contacted"],
  spam: ["contacted"],
}

export async function setLeadStatus(leadId: string, next: lead_status): Promise<void> {
  const admin = await requireAdmin()

  const lead = await db.leads.findUnique({
    where: { id: leadId },
    select: { id: true, status: true, type: true, email: true, contacted_at: true },
  })
  if (!lead) throw new Error("Lead not found")
  if (lead.status === next) return

  if (!TRANSITIONS[lead.status].includes(next)) {
    throw new Error(`Cannot move a ${lead.status} lead straight to ${next}.`)
  }

  // `open_key` is the idempotency guarantee, and it has to follow the status:
  // nulled when the lead closes so a genuine later request can come in, and
  // restored when one is reopened. Reopening can collide — someone may have
  // written in again since — so that case is reported rather than swallowed.
  const closing = (CLOSED_LEAD_STATUSES as readonly string[]).includes(next)
  const reopening = (CLOSED_LEAD_STATUSES as readonly string[]).includes(lead.status) && !closing

  if (reopening) {
    const clash = await db.leads.findUnique({
      where: { open_key: openKey(lead.type, lead.email) },
      select: { id: true },
    })
    if (clash) {
      throw new Error(
        "There is already an open lead for this email. Work that one instead of reopening this."
      )
    }
  }

  await db.leads.update({
    where: { id: leadId },
    data: {
      status: next,
      // One rule, shared with the ingest route. Never inline this.
      open_key: openKeyFor(next, lead.type, lead.email),
      // Stamped once, on the first move out of `new`. Re-stamping on a later
      // transition would destroy the response-time measurement, which is the
      // number this screen exists to make visible.
      ...(lead.contacted_at === null && next !== "spam" && next !== "archived"
        ? { contacted_at: new Date() }
        : {}),
    },
  })

  auditLog({
    userId: admin.id,
    action: "lead.status_changed",
    resource: "lead",
    resourceId: leadId,
    details: { from: lead.status, to: next },
  })
  revalidatePath("/dashboard/leads")
}

export async function assignLead(leadId: string, userId: string | null): Promise<void> {
  const admin = await requireAdmin()

  if (userId) {
    // Assigning to someone who cannot open the screen is a silent dead end.
    const assignee = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    })
    if (assignee?.role !== "app_admin") {
      throw new Error("Leads can only be assigned to an admin.")
    }
  }

  await db.leads.update({ where: { id: leadId }, data: { assigned_to: userId } })
  auditLog({
    userId: admin.id,
    action: "lead.assigned",
    resource: "lead",
    resourceId: leadId,
    details: { assignedTo: userId },
  })
  revalidatePath("/dashboard/leads")
}

/** Append-only: "called, no answer" and "called again, keen" are both worth keeping. */
export async function addLeadNote(leadId: string, body: string): Promise<void> {
  const admin = await requireAdmin()
  const text = body.trim()
  if (text.length < 2) throw new Error("Write something first.")

  await db.lead_notes.create({
    data: { lead_id: leadId, author_id: admin.id, body: text },
  })
  revalidatePath("/dashboard/leads")
}

export interface LeadDetail {
  id: string
  notes: { id: string; body: string; author: string | null; createdAt: Date }[]
  /** The highest-value widget on the screen — did this person already apply? */
  application: { status: string; displayName: string; createdAt: Date } | null
}

export async function getLeadDetail(leadId: string): Promise<LeadDetail | null> {
  await requireAdmin()

  const lead = await db.leads.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      email: true,
      notes: {
        orderBy: { created_at: "asc" },
        select: {
          id: true,
          body: true,
          created_at: true,
          author: { select: { name: true } },
        },
      },
    },
  })
  if (!lead) return null

  // Cross-referenced, never merged. A demo request is someone asking for a
  // walkthrough; an application is someone asking for platform access. Merging
  // the tables would put an unvetted marketing contact into a queue that grants
  // access.
  const application = await db.organiser_onboarding_requests.findFirst({
    where: { contact_email: lead.email },
    orderBy: { created_at: "desc" },
    select: { status: true, display_name: true, created_at: true },
  })

  return {
    id: lead.id,
    notes: lead.notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: n.author?.name ?? null,
      createdAt: n.created_at,
    })),
    application: application
      ? {
          status: application.status,
          displayName: application.display_name,
          createdAt: application.created_at,
        }
      : null,
  }
}
