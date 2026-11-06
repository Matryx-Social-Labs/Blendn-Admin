import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Characters as a person counts them, and as Postgres's `char_length` does: code points ("🎉" is one). */
export const characters = (text: string): number => [...text].length

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Up to two initials for an avatar; "B" when the name has none. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "B"
  )
}
