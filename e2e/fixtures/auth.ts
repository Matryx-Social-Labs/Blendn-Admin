/**
 * The seeded world's accounts, by role.
 *
 * `outsider` is the one most likely to be mistaken for a bug: it holds a
 * dashboard role and belongs to no organisation, so `eventPermissions` denies
 * it everywhere. Empty screens on that account are the correct answer — and
 * without it, "an organiser can edit" passes without anyone checking that *a
 * different* organiser cannot.
 */
export const ROLE_ACCOUNTS = {
  admin: { email: "admin@blendn.app", role: "app_admin" },
  organizer: { email: "organizer@blendn.app", role: "organizer" },
  venue: { email: "venue.owner@blendn.app", role: "venue_owner" },
  sponsor: { email: "sponsor@blendn.app", role: "sponsor" },
  outsider: { email: "daniel.weber@blendn.app", role: "organizer" },
  attendee: { email: "ananya.b@blendn.app", role: "attendee" },
} as const

export type RoleKey = keyof typeof ROLE_ACCOUNTS

/**
 * The dashboard shell's personas (seed-qa, step 14), kept apart from
 * ROLE_ACCOUNTS so the role sweeps do not visit every route four more times.
 * Each belongs to organisations of its own.
 */
export const PERSONA_ACCOUNTS = {
  multiOrg: { email: "ishaan.multi@blendn.app", role: "organizer" },
  partSuspended: { email: "tara.suspended@blendn.app", role: "organizer" },
  onlySuspended: { email: "omar.suspended@blendn.app", role: "organizer" },
  secondVenueOwner: { email: "kabir.venue@blendn.app", role: "venue_owner" },
} as const

export type PersonaKey = keyof typeof PERSONA_ACCOUNTS
