import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "command.updated"; commandId: number; name: string; status: string }
  | { type: "queue.updated" }
  | { type: "series.updated"; seriesId: number }
  | { type: "movie.updated"; movieId: number }
  | { type: "history.added" }
  | { type: "request.updated"; requestId: number }
  | { type: "health.changed" };

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
