import type { user_role } from "@prisma/client"
import { DefaultSession, DefaultJWT } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role: user_role
      /** The token's `signedInAt`, for `currentUser`'s own revocation check. */
      signedInAt?: number
      /** Held only to accept an org invite: `getAuth` answers null for it (SCRUM-984). */
      inviteOnly?: boolean
    } & DefaultSession["user"]
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    role: user_role
    /**
     * When this session signed in, ms since the epoch: set once, with the
     * user, and carried through every refresh. `iat` is re-stamped on each
     * re-encode, so it cannot say when the person last proved the password.
     */
    signedInAt?: number
    inviteOnly?: boolean
  }
}
