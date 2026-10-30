import { z } from "zod"

/**
 * A link the platform stores for somebody else to open: https only (SCRUM-956).
 *
 * `z.string().url()` takes anything the WHATWG parser reads, `javascript:` and
 * `data:` included. Every URL a user can write goes through this instead, so
 * the rule lives in one place and a new field cannot forget it.
 */
export const httpsUrl = (max = 2048) =>
  z
    .string()
    .trim()
    .url()
    .max(max)
    .refine((u) => /^https:\/\//i.test(u), "Use a web address that starts with https://")
