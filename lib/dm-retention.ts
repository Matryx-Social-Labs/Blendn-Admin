export async function purgeClosedConversations(_now: Date = new Date()) {
  return { messages: 0, photos: 0, kept: 0, hasMore: false }
}
