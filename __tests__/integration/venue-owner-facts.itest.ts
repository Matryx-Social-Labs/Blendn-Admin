import { venueOwnerFacts } from "@/lib/venue-owner-facts"

import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * What the admin's Venue owners list says beside each account (step 18):
 * the home organisation, the venues its organisations own, and the person's
 * own pending claims — read through live membership (a suspended
 * organisation owns nothing for anybody) and never counting a retired venue
 * or a decided claim.
 */

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []

async function org(label: string, status: "verified" | "suspended" = "verified") {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status } })
  orgs.push(o.id)
  return o
}
async function venue(ownerOrg: string, retired = false) {
  const v = await db.venues.create({
    data: { name: testId("Facts venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: ownerOrg, claimed_at: new Date(), ...(retired && { deleted_at: new Date() }) },
  })
  venues.push(v.id)
  return v.id
}

afterAll(async () => {
  await db.venue_claims.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

it("names the home org, counts live venues through live memberships, and the person's pending claims", async () => {
  const owner = await makeUser(testId("facts_owner"), "organizer")
  const nobody = await makeUser(testId("facts_none"), "organizer")
  users.push(owner, nobody)

  const home = await org("Facts Home")
  const second = await org("Facts Second")
  const suspended = await org("Facts Suspended", "suspended")
  await db.organisation_members.create({ data: { org_id: home.id, user_id: owner, role: "owner", created_at: new Date(Date.now() - 86_400_000) } })
  await db.organisation_members.create({ data: { org_id: second.id, user_id: owner, role: "staff" } })
  await db.organisation_members.create({ data: { org_id: suspended.id, user_id: owner, role: "owner" } })

  await venue(home.id)
  await venue(home.id)
  await venue(home.id, true) // retired: not counted
  await venue(second.id)
  await venue(suspended.id) // a suspended organisation's: not counted

  const unowned = await db.venues.create({ data: { name: testId("Facts unowned"), city: "Bengaluru", latitude: 12.9, longitude: 77.5 } })
  venues.push(unowned.id)
  await db.venue_claims.create({ data: { venue_id: unowned.id, org_id: home.id, filed_by: owner, status: "pending" } })
  // A decided claim, on another venue (one claim per venue per organisation): not counted.
  const declined = await db.venues.create({ data: { name: testId("Facts declined"), city: "Bengaluru", latitude: 12.91, longitude: 77.51 } })
  venues.push(declined.id)
  await db.venue_claims.create({ data: { venue_id: declined.id, org_id: second.id, filed_by: owner, status: "declined" } })

  const facts = await venueOwnerFacts([owner, nobody])
  expect(facts[owner]).toEqual({ org: home.display_name, venues: 3, pendingClaims: 1 })
  expect(facts[nobody]).toEqual({ org: null, venues: 0, pendingClaims: 0 })
  expect(await venueOwnerFacts([])).toEqual({})
})
