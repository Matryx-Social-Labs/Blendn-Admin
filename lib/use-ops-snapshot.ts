"use client"

import { useEffect, useState } from "react"
import { io, type Socket } from "socket.io-client"

import { OPS_INTERVAL_MS, type LiveSnapshot, type VenueLiveSnapshot } from "@/lib/live-metrics"

export type OpsStatus = "connecting" | "live" | "denied" | "error"

/**
 * Four of the server's ticks with no snapshot. A socket that stops answering
 * without closing (out of the venue's wifi) is otherwise noticed only by
 * Socket.io's ping, 85 s on (measured, SCRUM-1348). Not three: a slow snapshot
 * in a large room must not trip it.
 */
const QUIET_MS = 4 * OPS_INTERVAL_MS

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
  const [snapshot, setSnapshot] = useState<LiveSnapshot | VenueLiveSnapshot | null>(null)
  const [status, setStatus] = useState<OpsStatus>("connecting")

  useEffect(() => {
    if (!enabled) return

    let socket: Socket | null = null
    let cancelled = false
    let quiet: ReturnType<typeof setTimeout> | undefined

    // Same-origin: server.ts attaches Socket.io to the same HTTP server that
    // serves the dashboard, so there is no separate host to configure.
    socket = io({ withCredentials: true, transports: ["websocket", "polling"] })

    // Four ticks with no snapshot: the screen says its figures stopped, and it
    // asks again every four ticks until one comes. An open socket asks for the
    // join (unanswered, or one the server could not check, SCRUM-1402); a
    // socket Socket.io gave up on (a refused handshake destroys it) is opened
    // again. One Socket.io is still retrying is left alone: a `disconnect()`
    // then stops the retries for good and fires no `disconnect` event
    // (SCRUM-1444), and a transport that never closed is closed by its ping
    // and retried like any other drop.
    const armQuiet = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        if (cancelled) return
        setStatus("error")
        if (!socket?.active) socket?.connect()
        else if (socket.connected) socket.emit("join:eventOps", eventId)
        armQuiet()
      }, QUIET_MS)
    }

    socket.on("connect", () => {
      socket?.emit("join:eventOps", eventId)
      armQuiet()
    })

    // Which copy arrives is the server's decision, by who is watching (SCRUM-516).
    socket.on("ops:snapshot", (data: LiveSnapshot | VenueLiveSnapshot) => {
      if (cancelled || data.eventId !== eventId) return
      setSnapshot(data)
      setStatus("live")
      armQuiet()
    })

    socket.on("error", (payload: { message: string; code?: string }) => {
      if (cancelled) return
      clearTimeout(quiet)
      // Distinguished from a transport failure on purpose: "you may not watch
      // this" and "the connection dropped" need different words on screen. A
      // refusal is final and must not be turned into "connection lost" twenty
      // seconds later; any other answer (the server could not check, SCRUM-1402)
      // is asked again on the quiet timer.
      if (payload.code === "OPS_FORBIDDEN") {
        setStatus("denied")
        return
      }
      setStatus("error")
      armQuiet()
    })

    // A dropped transport is retried by Socket.io about a second later, and a
    // drop that comes back on that retry shows nothing. The first retry that
    // fails is this `connect_error`: from then the screen says its figures
    // stopped (SCRUM-1348). The next `ops:snapshot` clears it. Each one
    // restarts the quiet timer, so it fires only once Socket.io has stopped
    // trying: a refused handshake (an ended session, or a read that threw).
    socket.on("connect_error", () => {
      if (cancelled) return
      setStatus("error")
      armQuiet()
    })

    // A close Socket.io will not retry (the server sent DISCONNECT, as
    // `evictUserSockets` does) is stale at once, and is opened again here, so
    // the screen's "reconnecting" stays true; if the network is down by then,
    // the failed open falls back to Socket.io's own retries. An ended session
    // fails the handshake; a lost right is refused at the join.
    socket.on("disconnect", () => {
      if (cancelled || socket?.active) return
      setStatus("error")
      socket?.connect()
    })

    return () => {
      cancelled = true
      clearTimeout(quiet)
      socket?.emit("leave:eventOps", eventId)
      socket?.disconnect()
    }
  }, [eventId, enabled])

  return { snapshot, status }
}
