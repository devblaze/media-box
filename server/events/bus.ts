import { EventEmitter } from "node:events";

/**
 * A watch-together sync instruction mirrored from a host to their joiners:
 *   play/pause  → mirror the host's transport, at `positionSeconds`
 *   seek        → jump joiners to `positionSeconds`
 *   title       → the host changed episode/movie → point joiners at `target`
 */
export type WatchCommand = {
  kind: "play" | "pause" | "seek" | "title";
  positionSeconds?: number;
  target?: { type: "movie" | "episode"; id: number };
};

/**
 * Events with a `targetUserId` are delivered only to that user's SSE connections
 * (see app/api/v1/system/events/route.ts). Untargeted events fan out to everyone
 * (unchanged, cache-invalidation-only) behaviour.
 */
export type AppEvent =
  | { type: "command.updated"; commandId: number; name: string; status: string }
  | { type: "queue.updated" }
  | { type: "series.updated"; seriesId: number }
  | { type: "movie.updated"; movieId: number }
  | { type: "history.added" }
  | { type: "request.updated"; requestId: number }
  | { type: "fileChange.pending" }
  | { type: "fileChange.updated" }
  | { type: "health.changed" }
  // A user's Jellyfin watch-state sync finished (targeted: refresh their rows).
  | { type: "jellyfin.synced"; targetUserId: number }
  // Watch-together (targeted to a single user's connections):
  | { type: "watch.peerJoined"; targetUserId: number; joinerUsername: string }
  | { type: "watch.peerLeft"; targetUserId: number; joinerUsername: string }
  | { type: "watch.sync"; targetUserId: number; command: WatchCommand };

const BUS_KEY = Symbol.for("mediabox.bus");

type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: EventEmitter };

export function getBus(): EventEmitter {
  const g = globalThis as GlobalWithBus;
  if (!g[BUS_KEY]) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100); // one listener per open SSE connection
    g[BUS_KEY] = bus;
  }
  return g[BUS_KEY];
}

export function emitEvent(event: AppEvent) {
  getBus().emit("event", event);
}

export function onEvent(listener: (event: AppEvent) => void): () => void {
  const bus = getBus();
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
