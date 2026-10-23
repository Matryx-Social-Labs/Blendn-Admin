/**
 * A reveal landed in a DM: tell the people who should re-read it, on their own
 * `user:{id}` rooms (`private:revealed`, `docs/SOCKET_EVENTS.md`). Content-free:
 * the conversation id both sides already hold, so no name, photo or handle
 * rides on it. The caller has checked the conversation is open; a closed one is
 * told to nobody.
 *
 * Its own module, reading the `globalThis` io that lib/socket-server.ts
 * publishes (Next bundles its own copy of that file), so the matching library
 * need not import the whole socket server. No server attached means nobody to
 * tell.
 */
export function emitPrivateRevealed(conversationId: string, userIds: readonly string[]): void {
  if (userIds.length === 0) return
  globalThis.__blendnSocketIo?.to(userIds.map((id) => `user:${id}`)).emit("private:revealed", { conversationId })
}
