import NextAuth from "next-auth"

import { authOptions } from "@/lib/auth"

/**
 * The dashboard sign-in limits live in `authorize()` (lib/auth.ts), not here.
 *
 * They were here first, matching on the raw request path — and a percent-encoded
 * spelling of the credentials callback reaches this same catch-all with the
 * segment decoded and the path not, so it skipped them (audit 2026-10-24, WEB
 * H1). They were in `middleware.ts` before that, which runs on the Edge, where
 * Redis cannot load (SCRUM-194). `authorize()` runs in Node, on every path.
 */
const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
