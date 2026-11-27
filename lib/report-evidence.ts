export type EvidencePlace = { chatGroupId: string } | { eventId: string } | { conversationId: string }
export async function recentLines(_reporterId: string, _authorId: string, _place: EvidencePlace): Promise<string | null> {
  return null
}
