/**
 * What a member of a suspended organisation is told, and where.
 *
 * Suspension closes every door (SCRUM-8): the membership stops loading, the
 * events go dark, the org page loses its controls. A screen that is suddenly
 * empty with no sentence on it reads as the product being broken — so this is
 * in the dashboard shell above every page, and again on the org page in place
 * of the controls. Same box as "Email is not configured", because it is the
 * same kind of news: a state, not an error they caused.
 *
 * The reason is the admin's own words. It is shown because the admin was made
 * to write ten characters of it for exactly this reader.
 */
export function OrgSuspendedNotice({
  orgs,
}: {
  orgs: { id: string; display_name: string; reason: string | null }[]
}) {
  if (orgs.length === 0) return null
  return (
    <div
      role="status"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-[0.8125rem] leading-6"
    >
      {orgs.map((org) => (
        <p key={org.id}>
          <strong className="font-semibold">{org.display_name} is suspended.</strong>{" "}
          {org.reason ? <>{org.reason} </> : null}
          Its events are hidden and its dashboard is closed until the platform team reinstates it.
          Reply to the email you received if you think this is a mistake.
        </p>
      ))}
    </div>
  )
}
