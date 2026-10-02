/*
 * The home organisation is chosen by one order, with a tie-break, in both of
 * the places that choose it (step 14 review).
 *
 * `homeOrgIdFor` decides where a new event is filed; `activeOrgsFor` decides
 * which organisation the sidebar's card names. On an identical `created_at`
 * (two memberships written in one transaction, or by a seed) `created_at`
 * alone lets Postgres return either. The integration test
 * (`sidebar-identity-card.itest.ts`) shows today's database agreeing — but
 * only because the unique (user_id, org_id) index happens to feed the sort in
 * org_id order, which a different plan would not. So the order itself is
 * pinned here, at the query.
 */
const calls: { orderBy?: unknown }[] = []
jest.mock("@/lib/db", () => ({
  db: {
    organisation_members: {
      findFirst: (args: { orderBy?: unknown }) => {
        calls.push(args)
        return Promise.resolve(null)
      },
      findMany: (args: { orderBy?: unknown }) => {
        calls.push(args)
        return Promise.resolve([])
      },
    },
  },
}))

import { homeOrgIdFor } from "@/lib/event-ownership"
import { HOME_ORG_ORDER, activeOrgsFor } from "@/lib/org-membership"

it("orders oldest first, then by org_id", () => {
  expect(HOME_ORG_ORDER).toEqual([{ created_at: "asc" }, { org_id: "asc" }])
})

it("is the order both readers use", async () => {
  await homeOrgIdFor({ id: "u1", role: "organizer" })
  await activeOrgsFor("u1")
  expect(calls.map((c) => c.orderBy)).toEqual([HOME_ORG_ORDER, HOME_ORG_ORDER])
})
