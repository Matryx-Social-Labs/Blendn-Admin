import type { NextRequest } from "next/server"

/**
 * A webhook's body as bytes, or null once it passes `max` (the rest is never
 * read). A chunked body with no Content-Length is cut off at the cap, never
 * buffered whole. Shared by every provider's webhook route.
 */
export async function readCapped(req: NextRequest, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
