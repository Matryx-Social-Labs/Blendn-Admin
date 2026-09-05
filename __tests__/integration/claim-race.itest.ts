import { violatedConstraint } from "@/lib/prisma-errors"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Two admins approving competing claims on the same event.
 *
 * ## Why this is a database test and not a unit one
 *
 * `decideEventClaim` re-checks `claimRefusal` at decision time, which is
 * correct and is not a lock. A read outside a transaction cannot serialise
 * anything: two admins with the queue open both see `claimed_at IS NULL`, both
 * pass the check, and both commit — two rows saying `approved`, the event
 * belonging to whichever committed last, and a second organisation told they
 * got it. `event_claims_one_approved_per_event` is the only thing that stops
 * it, and it is a **partial** unique index, which `schema.prisma` cannot
 * express and `db push` therefore never creates.
 *
 * So a suite running against a `db push` database would pass while the rule it
 * describes was simply absent. That is the failure `scripts/seed-qa.ts` already
 * produced once in this project.
 *
 * The engineering review of W5 left this as its one open finding: the index was
 * the only thing enforcing the rule and no test exercised it.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  if (events.length) await db.event_claims.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  if (orgs.length) await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function org(label: string) {
  const row = await db.organisations.create({
    data: { display_name: `${label} ${testId("o")}`, kind: "company" },
    select: { id: true },
  })
  orgs.push(row.id)
  return row.id
}

async function contested() {
  const host = await makeUser(testId("cl-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const claim = (orgId: string) => ({
    event_id: eventId,
    org_id: orgId,
    contact_email: `${testId("c")}@example.com`,
    status: "approved" as const,
  })
  return { eventId, claim, a: await org("Alpha"), b: await org("Beta") }
}

describe("only one claim on an event can be approved", () => {
  it("refuses the second, whichever order they arrive in", async () => {
    const { claim, a, b } = await contested()

    await db.event_claims.create({ data: claim(a) })
    await expect(db.event_claims.create({ data: claim(b) })).rejects.toMatchObject({
      code: "P2002",
    })
  })

  it("refuses one of two that race, rather than accepting both", async () => {
    /*
     * The actual shape of the bug: not two sequential approvals, which the
     * decision-time re-check already catches, but two that overlap. Issued
     * together so both are in flight before either commits.
     */
    const { eventId, claim, a, b } = await contested()

    const results = await Promise.allSettled([
      db.event_claims.create({ data: claim(a) }),
      db.event_claims.create({ data: claim(b) }),
    ])

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)

    const approved = await db.event_claims.count({
      where: { event_id: eventId, status: "approved" },
    })
    expect(approved).toBe(1)
  })

  it("leaves `superseded` unbounded, because the losers are moved there", async () => {
    /*
     * The index predicate is `WHERE status = 'approved'` and that matters: the
     * approving transaction moves every other pending claim to `superseded` in
     * the same statement, so a unique index covering that status would make the
     * successful path fail on the second loser.
     */
    const { eventId, claim, a, b } = await contested()
    await db.event_claims.createMany({
      data: [
        { ...claim(a), status: "superseded" },
        { ...claim(b), status: "superseded" },
      ],
    })
    const superseded = await db.event_claims.count({
      where: { event_id: eventId, status: "superseded" },
    })
    expect(superseded).toBe(2)
  })

  it("names the constraint in the error, which is what the handler matches on", async () => {
    /*
     * THE assertion, and the reason this file exists rather than a unit test.
     *
     * `decideEventClaim` catches the violation with
     * `message.includes("event_claims_one_approved_per_event")` and turns it
     * into "Somebody else's claim was approved first." If the message does not
     * carry the constraint name, that catch never matches, the error escapes,
     * and the losing admin gets a raw 500 on a race the code was written to
     * handle gracefully.
     *
     * It cannot be assumed. This is a **partial index created in raw SQL**, so
     * Prisma has no model-level knowledge of it — and in this project's Prisma
     * a `P2002` reports the violated *fields* rather than the index name for
     * constraints it does know about. Asserting the production predicate
     * against a real violation is the only way to know it fires.
     */
    const { claim, a, b } = await contested()
    await db.event_claims.create({ data: claim(a) })

    const error = await db.event_claims.create({ data: claim(b) }).then(
      () => null,
      (e: unknown) => e
    )
    expect(error).not.toBeNull()

    /*
     * The production predicate, run against a real violation.
     *
     * `error.message` is "Unique constraint failed on the fields: (`event_id`)"
     * — the fields, never the index name — so the handler's original
     * `message.includes("event_claims_one_approved_per_event")` could not match
     * and the graceful path was unreachable. The name lives in
     * `meta.driverAdapterError.cause.originalMessage`, which is what
     * `violatedConstraint` reads.
     */
    const message = error instanceof Error ? error.message : String(error)
    expect(message).not.toContain("event_claims_one_approved_per_event")
    expect(violatedConstraint(error, "event_claims_one_approved_per_event")).toBe(true)

    // And it does not answer yes to a different index on the same table.
    expect(violatedConstraint(error, "event_claims_one_pending_per_org")).toBe(false)
  })
})
