/**
 * Every report reason, in one list (D-027, D-032).
 *
 * `severity` is the order a reviewer takes reports in (S1 first). `urgent`
 * marks the four reasons D-032 names: an intimate image shared without consent,
 * impersonation, somebody under 18, and child safety.
 *
 * The routes store a report's `reason` as the app sent it, so a free string from
 * an older app keeps its words; `reportReason` reads any stored value as one of
 * these, and anything unknown as `other`.
 *
 * Values the installed app sends: a person and Unmatch/Block and report
 * (harassment, inappropriate_messages, inappropriate_photos, fake_profile, spam,
 * other), a message and the Lobby (harassment, hate_speech, inappropriate_content,
 * spam, other), an event (misleading_listing, unsafe_venue, organiser_conduct,
 * not_real, other), a room (pile_on, hate_speech, unsafe, host_conduct, spam,
 * other), a crew (spam, offensive, contact_details, impersonation, other) and an
 * offer (offensive, misleading, spam, unsafe, other).
 */
export const REPORT_REASONS = {
  child_safety: { severity: "S1", urgent: true },
  intimate_image: { severity: "S1", urgent: true },
  under_18: { severity: "S1", urgent: true },
  impersonation: { severity: "S1", urgent: true },
  threat: { severity: "S1", urgent: false },
  unsafe: { severity: "S1", urgent: false },
  harassment: { severity: "S2", urgent: false },
  hate_speech: { severity: "S2", urgent: false },
  pile_on: { severity: "S2", urgent: false },
  inappropriate_content: { severity: "S2", urgent: false },
  inappropriate_messages: { severity: "S2", urgent: false },
  inappropriate_photos: { severity: "S2", urgent: false },
  offensive: { severity: "S2", urgent: false },
  fake_profile: { severity: "S2", urgent: false },
  host_conduct: { severity: "S2", urgent: false },
  organiser_conduct: { severity: "S2", urgent: false },
  unsafe_venue: { severity: "S2", urgent: false },
  spam: { severity: "S3", urgent: false },
  contact_details: { severity: "S3", urgent: false },
  misleading: { severity: "S3", urgent: false },
  misleading_listing: { severity: "S3", urgent: false },
  not_real: { severity: "S3", urgent: false },
  other: { severity: "S3", urgent: false },
} as const satisfies Record<string, { severity: "S1" | "S2" | "S3"; urgent: boolean }>

export type ReportReason = keyof typeof REPORT_REASONS

/** A stored reason as one of the list (trimmed, any case); anything else is `other`. */
export function reportReason(stored: string | null | undefined): ReportReason {
  const key = stored?.trim().toLowerCase() ?? ""
  return Object.hasOwn(REPORT_REASONS, key) ? (key as ReportReason) : "other"
}
