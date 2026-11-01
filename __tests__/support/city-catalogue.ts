/** Forget the cached catalogue and previewers (lib/cities.ts), for a test that writes a row and then reads it. */
export function clearCityCatalogue(): void {
  const shared = globalThis as { __blendnCityCatalogue?: unknown; __blendnMarketPreviewers?: Map<string, unknown> }
  shared.__blendnCityCatalogue = null
  shared.__blendnMarketPreviewers?.clear()
}
