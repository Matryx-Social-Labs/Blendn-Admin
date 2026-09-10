/**
 * A stand-in for `jose`, for the integration runner only.
 *
 * `jose` ships ESM only, and the integration config transforms TypeScript
 * rather than `node_modules`, so importing `lib/mobile-auth.ts` for real — which
 * the refresh-token suite must, since the defect it covers only appears against
 * a real Prisma client — fails to parse before any test runs.
 *
 * The unit suite never hits this because it mocks the module wholesale.
 *
 * Only Apple sign-in verification uses these, and no integration test
 * exercises it. If one ever does, it must not use this file: these throw rather
 * than returning a plausible-looking verification, because a stub that quietly
 * "verifies" an identity token is the most dangerous thing this directory could
 * contain.
 */
export function jwtVerify(): never {
  throw new Error("jose.jwtVerify is stubbed in integration tests — do not verify identity here")
}

/*
 * Constructs, and throws only if the key set is actually used.
 *
 * `lib/mobile-auth.ts` calls this at module load, so a version that threw
 * immediately made the module unimportable and every suite touching it failed
 * before running a single test. Returning a throwing function keeps the
 * property that matters — nothing here can quietly "verify" an identity token —
 * while letting the module load.
 */
export function createRemoteJWKSet(): () => never {
  return () => {
    throw new Error("jose key set is stubbed in integration tests — do not verify identity here")
  }
}
