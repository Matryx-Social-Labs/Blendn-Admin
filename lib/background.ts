// Relative imports: reachable from server.ts, and `build:server` compiles with
// plain tsc, which emits the @/ alias verbatim into the require().
import { logger } from "./logger"
import { startChatLifecycleSweeper, stopChatLifecycleSweeper } from "./chat-lifecycle"
import { startPresenceSweeper, stopPresenceSweeper } from "./presence-sweeper"
import { startSentimentSweeper, stopSentimentSweeper } from "./sentiment-sweeper"

/**
 * Every recurring job this process owns, in one place.
 *
 * ## Why this is not inside `initSocketServer`
 *
 * It used to be. Four loops were started as a side effect of attaching a
 * websocket server, which coupled them to a decision they have nothing to do
 * with — none of them emits over a socket, and three of them exist to keep
 * numbers honest whether or not anyone is connected.
 *
 * The consequence was silence, not an error. Serve the app any way that does
 * not call `initSocketServer` — `next start`, a preview deploy, a worker
 * container — and every one of them stops with no log line. The presence
 * sweeper stopping means nobody is ever checked out, so occupancy climbs for
 * ever and `over_capacity` latches as a permanent critical alert; the sentiment
 * sweeper stopping renders as "the event was quiet".
 *
 * Making it a step `server.ts` takes deliberately means the coupling is visible,
 * a structural test can assert it, and splitting these into a worker process
 * later is moving one call rather than untangling an initialiser.
 *
 * ## What is not here
 *
 * `sponsoredMessageScheduler` stays in `lib/socket-server.ts`: it emits into
 * chat rooms, so it genuinely needs `io` to exist first. It is stopped by the
 * same shutdown handler.
 */
export function startBackgroundWork(): void {
  // Chat rooms close themselves. No external cron to configure — and the
  // immediate pass on boot is the important one, since deploys restart this
  // process often enough that boot is when any backlog gets cleared.
  startChatLifecycleSweeper()
  startPresenceSweeper()
  // Classifies chatroom messages into event_feedback, which is what the live
  // screen's mood and category panels have always read and never had.
  startSentimentSweeper()

  logger.info("Background work started", {
    loops: ["chat-lifecycle", "presence", "sentiment"],
  })
}

/**
 * Stop them all. Called from the shutdown handler.
 *
 * Every one of these holds an unref'd timer, so a missed stop keeps the event
 * loop alive and the process waits out the forced-exit timeout — which is how
 * the ops broadcast came to be the fifth timer nobody was stopping.
 */
export function stopBackgroundWork(): void {
  stopChatLifecycleSweeper()
  stopPresenceSweeper()
  stopSentimentSweeper()
}
