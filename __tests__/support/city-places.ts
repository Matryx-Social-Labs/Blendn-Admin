/** Forget the picker's cached places (lib/city-places.ts), for a test that writes a venue and then reads the picker. */
export function clearCityPlaces(): void {
  ;(globalThis as { __blendnCityPlaces?: unknown }).__blendnCityPlaces = null
}
