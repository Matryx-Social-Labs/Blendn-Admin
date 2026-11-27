export const REPORT_REASONS = {} as Record<string, { severity: "S1" | "S2" | "S3"; urgent: boolean }>
export function reportReason(_stored: string | null | undefined): string {
  return "other"
}
