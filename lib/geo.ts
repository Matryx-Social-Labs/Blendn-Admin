/**
 * Geographic utility functions
 */

const EARTH_RADIUS_KM = 6371

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180)
}

/**
 * Calculate the haversine distance between two points in kilometers
 *
 * @param lat1 - Latitude of point 1 in degrees
 * @param lon1 - Longitude of point 1 in degrees
 * @param lat2 - Latitude of point 2 in degrees
 * @param lon2 - Longitude of point 2 in degrees
 * @returns Distance in kilometers
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_KM * c
}

/**
 * Calculate the haversine distance in meters
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return haversineDistance(lat1, lon1, lat2, lon2) * 1000
}

/**
 * Get a bounding box for a given center point and radius
 * This is useful for initial database filtering before precise distance calculation
 *
 * @param lat - Center latitude in degrees
 * @param lon - Center longitude in degrees
 * @param radiusKm - Radius in kilometers
 * @returns Bounding box coordinates
 */
export function getBoundingBox(
  lat: number,
  lon: number,
  radiusKm: number
): {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
} {
  // Approximate degrees per km at this latitude
  const latDelta = radiusKm / 111.32 // 1 degree of latitude is ~111.32 km
  const lonDelta = radiusKm / (111.32 * Math.cos(toRadians(lat)))

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  }
}

/**
 * Check if a point is within a given radius of another point
 *
 * @param lat1 - Latitude of center point
 * @param lon1 - Longitude of center point
 * @param lat2 - Latitude of point to check
 * @param lon2 - Longitude of point to check
 * @param radiusKm - Radius in kilometers
 * @returns True if point is within radius
 */
export function isWithinRadius(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusKm: number
): boolean {
  return haversineDistance(lat1, lon1, lat2, lon2) <= radiusKm
}

/**
 * Check if a point is within a given radius in meters
 */
export function isWithinRadiusMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusMeters: number
): boolean {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) <= radiusMeters
}
