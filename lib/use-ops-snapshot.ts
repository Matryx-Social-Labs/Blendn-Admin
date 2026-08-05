"use client"

import { useEffect, useState } from "react"
import { io, type Socket } from "socket.io-client"

import type { LiveSnapshot } from "@/lib/live-metrics"

export type OpsStatus = "connecting" | "live" | "denied" | "error"

/**
 * Subscribe to one event's live operations room.
 *
 * Authentication is the session cookie — `withCredentials` makes the handshake
 * send it, and the server's dashboard path reads it. No token is passed from
 * client code, so there is nothing here for a compromised page to exfiltrate.
 *
 * The connection is torn down on unmount and on event change. That matters more
 * than usual: the server runs a per-event snapshot timer only while someone is
 * watching, and a leaked socket would keep it querying for a screen nobody has
 * open.
 */
export function useOpsSnapshot(eventId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [status, setStatus] = useState<OpsStatus>("connecting")

  useEffect(() => {
    if (!enabled) return

    let socket: Socket | null = null
    let cancelled = false

    // Same-origin: server.ts attaches Socket.io to the same HTTP server that
    // serves the dashboard, so there is no separate host to configure.
    socket = io({ withCredentials: true, transports: ["websocket", "polling"] })

    socket.on("connect", () => {
      socket?.emit("join:eventOps", eventId)
    })

    socket.on("ops:snapshot", (data: LiveSnapshot) => {
      if (cancelled || data.eventId !== eventId) return
      setSnapshot(data)
      setStatus("live")
    })

    socket.on("error", (payload: { message: string; code?: string }) => {
      if (cancelled) return
      // Distinguished from a transport failure on purpose: "you may not watch
      // this" and "the connection dropped" need different words on screen.
      setStatus(payload.code === "OPS_FORBIDDEN" ? "denied" : "error")
    })

    socket.on("connect_error", () => {
      if (!cancelled) setStatus("error")
    })

    return () => {
      cancelled = true
      socket?.emit("leave:eventOps", eventId)
      socket?.disconnect()
    }
  }, [eventId, enabled])

  return { snapshot, status }
}
