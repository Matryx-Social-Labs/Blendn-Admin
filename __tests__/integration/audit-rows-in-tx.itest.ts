import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * A lead note, an issue acknowledgement and an organisation's status change
 * each write their audit row in the transaction that makes the change
 * (SCRUM-1389): the change and its record commit together or not at all.
 *
 * Real actions against a `db:migrate` database, rows read back without
 * polling. `auditInTx` is the real writer, wrapped so one call can be made to
 * fail: the change it records must then not be there either.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/audit-log", () => {
  const actual = jest.requireActual("@/lib/audit-log")
  return { ...actual, auditInTx: jest.fn(actual.auditInTx) }
})

import { auditInTx } from "@/lib/audit-log"
import { addLeadNote } from "@/lib/lead-actions"
import { setOrganisationStatus } from "@/lib/onboarding-actions"
import { acknowledgeIssue } from "@/app/dashboard/events/[id]/issue-actions"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const leads: string[] = []
const venues: string[] = []

beforeEach(() => jest.mocked(auditInTx).mockClear())

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.leads.deleteMany({ where: { id: { in: leads } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

const FAIL = new Error("audit write failed")
const auditRows = (action: string, resourceId: string) =>
  db.audit_logs.findMany({
    where: { action, resource_id: resourceId },
    select: { action: true, resource: true, resource_id: true, user_id: true, details: true, org_id: true },
  })

async function signedInAdmin() {
  const admin = await makeUser("art-admin", "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
  return admin
}

async function lead() {
  const email = `${testId("lead")}@itest.invalid`
  const l = await db.leads.create({ data: { type: "demo_request", email, email_root: email, submitted_at: new Date() } })
  leads.push(l.id)
  return l.id
}

describe("a lead note", () => {
  it("writes lead.note_added with the note's id and length, never its text", async () => {
    const admin = await signedInAdmin()
    const leadId = await lead()

    await addLeadNote(leadId, "  Called, no answer. Her number is 98450 12345.  ")

    const [note] = await db.lead_notes.findMany({ where: { lead_id: leadId }, select: { id: true, body: true } })
    expect(note.body).toBe("Called, no answer. Her number is 98450 12345.")
    expect(await auditRows("lead.note_added", leadId)).toEqual([
      { action: "lead.note_added", resource: "lead", resource_id: leadId, user_id: admin, org_id: null, details: { noteId: note.id, length: note.body.length } },
    ])
  })

  it("is not added when its audit row cannot be written", async () => {
    await signedInAdmin()
    const leadId = await lead()
    jest.mocked(auditInTx).mockRejectedValueOnce(FAIL)

    await expect(addLeadNote(leadId, "Called again, keen.")).rejects.toThrow(FAIL.message)

    expect(auditInTx).toHaveBeenCalled()
    expect(await db.lead_notes.count({ where: { lead_id: leadId } })).toBe(0)
    expect(await auditRows("lead.note_added", leadId)).toEqual([])
  })

  it("is refused to anyone but an admin, and nothing is written", async () => {
    const leadId = await lead()
    const host = await makeUser("art-lead-host", "organizer")
    users.push(host)
    session = { user: { id: host, role: "organizer" } }

    await expect(addLeadNote(leadId, "Called, no answer.")).rejects.toThrow("Forbidden")

    expect(await db.lead_notes.count({ where: { lead_id: leadId } })).toBe(0)
    expect(await auditRows("lead.note_added", leadId)).toEqual([])
  })
})

describe("acknowledging an event's issue", () => {
  async function fixture() {
    const host = await makeUser("art-host", "organizer")
    const colleague = await makeUser("art-colleague", "organizer")
    users.push(host, colleague)
    const org = await db.organisations.create({ data: { display_name: testId("Ack Org"), status: "verified" } })
    orgs.push(org.id)
    await db.organisation_members.createMany({
      data: [
        { org_id: org.id, user_id: host, role: "owner" },
        { org_id: org.id, user_id: colleague, role: "staff" },
      ],
    })
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
    const issue = await db.event_issues.create({
      data: { event_id: eventId, kind: "over_capacity", severity: "critical", title: "Over stated capacity", body: "14 guests against capacity 11." },
    })
    return { host, colleague, org: org.id, eventId, issueId: issue.id }
  }

  it("writes event.issue_acknowledged on the event, in its organisation's log, with no alert wording", async () => {
    const f = await fixture()
    session = { user: { id: f.host, role: "organizer" } }

    await acknowledgeIssue(f.issueId)

    const issue = await db.event_issues.findUniqueOrThrow({ where: { id: f.issueId }, select: { acknowledged_at: true, acknowledged_by: true } })
    expect(issue.acknowledged_at).toBeInstanceOf(Date)
    expect(issue.acknowledged_by).toBe(f.host)
    expect(await auditRows("event.issue_acknowledged", f.eventId)).toEqual([
      { action: "event.issue_acknowledged", resource: "event", resource_id: f.eventId, user_id: f.host, org_id: f.org, details: { issueId: f.issueId, kind: "over_capacity" } },
    ])
  })

  it("a second acknowledgement keeps the first and writes no second row", async () => {
    const f = await fixture()
    session = { user: { id: f.host, role: "organizer" } }
    await acknowledgeIssue(f.issueId)
    session = { user: { id: f.colleague, role: "organizer" } }

    await acknowledgeIssue(f.issueId)

    const issue = await db.event_issues.findUniqueOrThrow({ where: { id: f.issueId }, select: { acknowledged_by: true } })
    expect(issue.acknowledged_by).toBe(f.host)
    expect((await auditRows("event.issue_acknowledged", f.eventId)).map((r) => r.user_id)).toEqual([f.host])
  })

  it("is refused to someone who cannot operate the event, and nothing is written", async () => {
    const f = await fixture()
    const outsider = await makeUser("art-outsider", "organizer")
    users.push(outsider)
    session = { user: { id: outsider, role: "organizer" } }

    await expect(acknowledgeIssue(f.issueId)).rejects.toThrow("Not authorised")

    const issue = await db.event_issues.findUniqueOrThrow({ where: { id: f.issueId }, select: { acknowledged_at: true } })
    expect(issue.acknowledged_at).toBeNull()
    expect(await auditRows("event.issue_acknowledged", f.eventId)).toEqual([])
  })

  it("by the venue's side is recorded, but in no organisation's log: a host never reads what another organisation's people did", async () => {
    const f = await fixture()
    const venueStaff = await makeUser("art-venue", "organizer")
    users.push(venueStaff)
    const venueOrg = await db.organisations.create({ data: { display_name: testId("Venue Org"), status: "verified" } })
    orgs.push(venueOrg.id)
    await db.organisation_members.create({ data: { org_id: venueOrg.id, user_id: venueStaff, role: "owner" } })
    const venue = await db.venues.create({ data: { name: testId("art-venue"), city: "Bengaluru", owner_org_id: venueOrg.id, claimed_at: new Date(Date.now() - 24 * 3_600_000) }, select: { id: true } })
    venues.push(venue.id)
    await db.events.update({ where: { id: f.eventId }, data: { venue_id: venue.id, venue_link_status: "auto_linked" } })
    session = { user: { id: venueStaff, role: "organizer" } }

    await acknowledgeIssue(f.issueId)

    expect(await auditRows("event.issue_acknowledged", f.eventId)).toEqual([
      { action: "event.issue_acknowledged", resource: "event", resource_id: f.eventId, user_id: venueStaff, org_id: null, details: { issueId: f.issueId, kind: "over_capacity" } },
    ])
  })

  it("is not acknowledged when its audit row cannot be written", async () => {
    const f = await fixture()
    session = { user: { id: f.host, role: "organizer" } }
    jest.mocked(auditInTx).mockRejectedValueOnce(FAIL)

    await expect(acknowledgeIssue(f.issueId)).rejects.toThrow(FAIL.message)

    expect(auditInTx).toHaveBeenCalled()
    const issue = await db.event_issues.findUniqueOrThrow({ where: { id: f.issueId }, select: { acknowledged_at: true, acknowledged_by: true } })
    expect(issue).toEqual({ acknowledged_at: null, acknowledged_by: null })
    expect(await auditRows("event.issue_acknowledged", f.eventId)).toEqual([])
  })
})

describe("an organisation's status change", () => {
  async function fixture() {
    const host = await makeUser("art-org-host", "organizer")
    users.push(host)
    const org = await db.organisations.create({ data: { display_name: testId("Status Org"), status: "verified" } })
    orgs.push(org.id)
    await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
    return { org: org.id, eventId }
  }
  const stateOf = async (orgId: string, eventId: string) => ({
    org: await db.organisations.findUniqueOrThrow({ where: { id: orgId }, select: { status: true, suspended_at: true, suspension_reason: true } }),
    event: await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { status: true, pre_suspension_status: true } }),
  })

  it("writes organisation.suspended and organisation.verified with the status before, the reason and the events moved", async () => {
    const admin = await signedInAdmin()
    const f = await fixture()

    await setOrganisationStatus(f.org, "suspended", "Repeated safety reports at their events.")
    await setOrganisationStatus(f.org, "verified")

    expect(await auditRows("organisation.suspended", f.org)).toEqual([
      { action: "organisation.suspended", resource: "organisation", resource_id: f.org, user_id: admin, org_id: f.org, details: { from: "verified", reason: "Repeated safety reports at their events.", eventsHidden: 1, eventsRestored: 0 } },
    ])
    expect(await auditRows("organisation.verified", f.org)).toEqual([
      { action: "organisation.verified", resource: "organisation", resource_id: f.org, user_id: admin, org_id: f.org, details: { from: "suspended", reason: null, eventsHidden: 0, eventsRestored: 1 } },
    ])
  })

  it("records the status it changed from even while another admin's change is still committing", async () => {
    await signedInAdmin()
    const f = await fixture()
    await db.organisations.update({ where: { id: f.org }, data: { status: "pending" } })

    // Another admin verifies it and has not committed yet.
    let commit!: () => void
    let locked!: () => void
    const held = new Promise<void>((resolve) => { commit = resolve })
    const isLocked = new Promise<void>((resolve) => { locked = resolve })
    const other = db.$transaction(async (tx) => {
      await tx.organisations.update({ where: { id: f.org }, data: { status: "verified" } })
      locked()
      await held
    }, { timeout: 30_000 })
    await isLocked

    const suspending = setOrganisationStatus(f.org, "suspended", "Repeated safety reports at their events.")
    // Until it waits on the other admin's row lock, whichever statement that is.
    for (let i = 0; i < 300; i++) {
      const [{ n }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%organisations%' AND datname = current_database()`
      if (n > 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    commit()
    await other
    await suspending

    expect((await auditRows("organisation.suspended", f.org)).map((r) => (r.details as { from: string }).from)).toEqual(["verified"])
  })

  it("is refused to anyone but an admin, and nothing is written", async () => {
    const f = await fixture()
    const host = await makeUser("art-org-outsider", "organizer")
    users.push(host)
    session = { user: { id: host, role: "organizer" } }
    const before = await stateOf(f.org, f.eventId)

    await expect(setOrganisationStatus(f.org, "suspended", "Repeated safety reports at their events.")).rejects.toThrow("Forbidden")

    expect(await stateOf(f.org, f.eventId)).toEqual(before)
    expect(await auditRows("organisation.suspended", f.org)).toEqual([])
  })

  it("is not suspended, and hides nothing, when its audit row cannot be written", async () => {
    await signedInAdmin()
    const f = await fixture()
    const before = await stateOf(f.org, f.eventId)
    jest.mocked(auditInTx).mockRejectedValueOnce(FAIL)

    await expect(setOrganisationStatus(f.org, "suspended", "Repeated safety reports at their events.")).rejects.toThrow(FAIL.message)

    expect(auditInTx).toHaveBeenCalled()
    expect(await stateOf(f.org, f.eventId)).toEqual(before)
    expect(before.event.status).toBe("published")
    expect(await auditRows("organisation.suspended", f.org)).toEqual([])
  })
})
