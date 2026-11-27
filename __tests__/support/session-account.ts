/**
 * For a unit test's `@/lib/db` mock: answers the session readers' one statement (`sessionAccount`, `signinAccount` in
 * lib/org-membership.ts) from a row shaped like the `user.findUnique` read they replaced (SCRUM-1247).
 *
 * A host role on the row stands for a live membership of an organisation of that kind, since that is what a host's
 * dashboard is now, so a fixture written as "an organizer" stays one. A `home_kind` in the row overrides. What the
 * derivation itself does is pinned in `dashboard-role.test.ts` and, against Postgres, its itest.
 */
export async function mockSessionRows(row: unknown): Promise<Record<string, unknown>[]> {
  const r = (await row) as Record<string, unknown> | null | undefined
  if (!r) return []
  const host = r.role === "organizer" || r.role === "venue_owner" || r.role === "sponsor"
  return [
    {
      id: "u",
      email: "u@x.test",
      name: null,
      suspended_at: null,
      deletedAt: null,
      password_changed_at: null,
      sessions_revoked_at: null,
      home_kind: host ? r.role : null,
      ...r,
    },
  ]
}

/**
 * The same, one level up: what `sessionAccount` returns, for a test that mocks that seam because its `$queryRaw` mock
 * already answers other raw reads.
 */
export async function mockSessionAccount(row: unknown): Promise<Record<string, unknown> | null> {
  const [r] = await mockSessionRows(row)
  if (!r) return null
  const { home_kind, ...account } = r
  return { ...account, dashboardRole: r.role === "app_admin" ? "app_admin" : (home_kind ?? "attendee") }
}
