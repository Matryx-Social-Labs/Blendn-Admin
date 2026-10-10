import type { PrismaClient } from "@prisma/client"

import { emailRoot, openKeyFor } from "../lib/leads"
import { slugify, TAXONOMY } from "./seed-categories"
import { MATRIX_MARKERS } from "./seed-matrix-markers"

/*
 * The rows the admin screens show, so the access matrix can tell a page that
 * refused from a page that had nothing to show (step 18, DK-E01).
 *
 * `e2e/access-matrix.spec.ts` asserts a role receives none of a page's rows by
 * looking for a string that only appears when they rendered — and the positive
 * control (an admin does see it) is what keeps that from passing vacuously. A
 * page whose table is empty in the seeded world can do neither half, so it sat
 * in `STREAMED_OR_UNSEEDED`, checked for reachability and nothing else. Each
 * row here is one page taken off that list.
 *
 * Decided states where the page can show them (`?status=` on the flag, report
 * and lead queues), so the seeded world keeps the property the design work
 * leans on: nothing new is pending except the one creative, whose queue shows
 * pending rows and nothing else.
 *
 * Idempotent on a natural key each, like the rest of `seed-qa`, and left alone
 * once a tester has acted on it.
 */

type Db = PrismaClient

/**
 * The taxonomy `seed-qa`'s events are tagged with.
 *
 * It printed "category not found — run seed:categories" for every event on a
 * fresh database, CI's included, so the category manager rendered nothing and
 * every seeded event went untagged. Upserted with an empty `update`, so an
 * environment that already has the taxonomy (staging) keeps every rename an
 * admin made.
 */
export async function seedTaxonomy(db: Db): Promise<void> {
  for (const [parentName, childNames] of Object.entries(TAXONOMY)) {
    const parent = await db.categories.upsert({
      where: { slug: slugify(parentName) },
      update: {},
      create: { name: parentName, slug: slugify(parentName) },
    })
    for (const childName of childNames) {
      const slug = `${slugify(parentName)}-${slugify(childName)}`
      await db.categories.upsert({
        where: { slug },
        update: {},
        create: { name: childName, slug, parent_id: parent.id },
      })
    }
  }
}

export async function seedMatrixMarkers(
  db: Db,
  ids: { admin: string; attendees: string[]; brandId: string }
): Promise<void> {
  await seedLead(db, ids.admin)
  await seedDecidedFlag(db, ids.admin)
  await seedReviewedReport(db, ids)
  await seedPlacement(db, ids)
  await seedAuditRow(db, ids.admin)
}

/**
 * A lead somebody already called back (`?status=contacted`, never the default
 * view), from the address The Humming Tree applied with — so its drawer shows
 * "Already applied", which is the one thing that stops a lead being chased
 * after it signed up.
 */
async function seedLead(db: Db, admin: string) {
  const email = MATRIX_MARKERS.lead
  if (await db.leads.findFirst({ where: { email }, select: { id: true } })) return
  await db.leads.create({
    data: {
      type: "demo_request",
      status: "contacted",
      email,
      email_root: emailRoot(email),
      open_key: openKeyFor("contacted", "demo_request", email),
      name: "Priya Rao",
      organization: "The Humming Tree",
      event_types: "Gigs and listening sessions",
      city: "Bengaluru",
      // Arrived before it was answered, or the median time to contact goes negative.
      created_at: new Date(Date.now() - 30 * 3_600_000),
      submitted_at: new Date(Date.now() - 30 * 3_600_000),
      contacted_at: new Date(Date.now() - 20 * 3_600_000),
      assigned_to: admin,
    },
  })
}

/**
 * A flag a person already cleared, on the room's phone-number message. Kept,
 * not removed — the room still reads it — and it is not pending, so the
 * moderation badge and the overview's queue stay at zero.
 */
async function seedDecidedFlag(db: Db, admin: string) {
  const message = await db.chat_messages.findFirst({
    where: { content: { contains: "98450 12345" } },
    select: { id: true, chat_group_id: true, user_id: true },
  })
  if (!message) return
  if (await db.moderation_flags.findFirst({ where: { message_id: message.id }, select: { id: true } })) return
  await db.moderation_flags.create({
    data: {
      message_id: message.id,
      chat_group_id: message.chat_group_id,
      user_id: message.user_id,
      source: "auto_keyword",
      status: "approved",
      categories: { contact_info: 1 },
      confidence: 0.62,
      auto_action: "none",
      reviewed_by: admin,
      reviewed_at: new Date(Date.now() - 2 * 3_600_000),
      review_notes: "A meeting point, not a solicitation.",
    },
  })
}

/** A report a person looked at and took no action on: `?status=reviewed`. */
async function seedReviewedReport(db: Db, ids: { admin: string; attendees: string[] }) {
  const [reporter, reported] = ids.attendees
  if (!reporter || !reported) return
  const description = MATRIX_MARKERS.report
  if (await db.user_reports.findFirst({ where: { description }, select: { id: true } })) return
  await db.user_reports.create({
    data: {
      reporter_id: reporter,
      reported_id: reported,
      reason: "harassment",
      description,
      status: "reviewed",
      reviewed_by: ids.admin,
      reviewed_at: new Date(Date.now() - 6 * 3_600_000),
    },
  })
}

/**
 * Blue Tokai at Design Week, agreed and unpriced — the ledger's "unbilled" row
 * — with one sponsored message whose copy waits on creative review.
 *
 * The one pending row here, because the creative queue shows pending copy and
 * nothing else; there is no decided view to put it in.
 */
async function seedPlacement(db: Db, ids: { admin: string; brandId: string }) {
  const event = await db.events.findUnique({ where: { slug: "design-week-bengaluru" }, select: { id: true } })
  if (!event) return

  await db.event_sponsors.upsert({
    where: { event_id_sponsor_id: { event_id: event.id, sponsor_id: ids.brandId } },
    update: {},
    create: {
      event_id: event.id,
      sponsor_id: ids.brandId,
      status: "approved",
      created_by: ids.admin,
      decided_by: ids.admin,
      decided_at: new Date(Date.now() - 48 * 3_600_000),
    },
  })

  const content = MATRIX_MARKERS.creative
  if (await db.sponsored_creatives.findFirst({ where: { content }, select: { id: true } })) return
  const message = await db.event_sponsored_messages.create({
    data: { event_id: event.id, sponsor_id: ids.brandId, content, interval_minutes: 45 },
  })
  await db.sponsored_creatives.create({ data: { message_id: message.id, content } })
}

/** An admin's own act: no organisation's colleague, so no host's audit log shows it. */
async function seedAuditRow(db: Db, admin: string) {
  const reason = MATRIX_MARKERS.audit
  const existing = await db.audit_logs.findFirst({
    where: { user_id: admin, action: "seed.world_checked", resource: "platform" },
    select: { id: true },
  })
  if (existing) return
  await db.audit_logs.create({
    data: { user_id: admin, action: "seed.world_checked", resource: "platform", details: { reason } },
  })
}
