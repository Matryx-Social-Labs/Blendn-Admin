import { getAccessibleMediaUrl } from "@/lib/tigris"

const IMAGE_FIELD_KEYS = new Set(["image", "avatar"])
const IMAGE_ARRAY_FIELD_KEYS = new Set(["photos"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export async function resolveMediaFields<T>(value: T): Promise<T> {
  if (Array.isArray(value)) {
    const resolved = await Promise.all(value.map((item) => resolveMediaFields(item)))
    return resolved as T
  }

  if (!isPlainObject(value)) {
    return value
  }

  const resolvedEntries = await Promise.all(
    Object.entries(value).map(async ([key, fieldValue]) => {
      if (IMAGE_FIELD_KEYS.has(key) && typeof fieldValue === "string") {
        return [key, await getAccessibleMediaUrl(fieldValue)] as const
      }

      if (IMAGE_ARRAY_FIELD_KEYS.has(key) && Array.isArray(fieldValue)) {
        const urls = await Promise.all(
          fieldValue.map(async (item) =>
            typeof item === "string" ? getAccessibleMediaUrl(item) : item
          )
        )
        return [key, urls] as const
      }

      return [key, await resolveMediaFields(fieldValue)] as const
    })
  )

  return Object.fromEntries(resolvedEntries) as T
}
