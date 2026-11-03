"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { refusalMessage } from "@/lib/refusal"

import type { ActionResult } from "./actions"

/**
 * Run one of the Tickets tab's actions: a toast with its sentence, and the
 * server's page again on success. The actions answer in sentences
 * (`ActionResult`); a throw is the stale-page or network case.
 */
export function useTicketAction() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const run = (action: () => Promise<ActionResult>, onDone?: () => void) =>
    start(async () => {
      try {
        const res = await action()
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        if (res.message) toast.success(res.message)
        onDone?.()
        router.refresh()
      } catch (error) {
        toast.error(refusalMessage(error, "That didn’t go through. Try again."))
      }
    })
  return { pending, run }
}
