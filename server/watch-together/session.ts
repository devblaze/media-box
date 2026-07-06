/**
 * In-memory watch-together session registry: which joiners are currently watching
 * along with which host. Ephemeral by design — a restart clears it, and a joiner
 * simply re-joins. Stored on `globalThis` so route handlers, the scheduler and dev
 * HMR all share one map (mirrors server/events/bus.ts).
 *
 * A joiner can follow at most one host at a time; joining a new host (or leaving)
 * removes them from any previous host's set.
 */

const REGISTRY_KEY = Symbol.for("mediabox.watchTogether");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<number, Set<number>>;
};

/** hostUserId → set of joiner userIds currently synced to that host. */
function registry(): Map<number, Set<number>> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}

/** Attach a joiner to a host, detaching them from any previous host first. */
export function join(hostId: number, joinerId: number): void {
  leave(joinerId);
  const reg = registry();
  let set = reg.get(hostId);
  if (!set) {
    set = new Set();
    reg.set(hostId, set);
  }
  set.add(joinerId);
}

/** Remove a joiner from whichever host they were following (no-op if none). */
export function leave(joinerId: number): void {
  const reg = registry();
  for (const [hostId, joiners] of reg) {
    if (joiners.delete(joinerId) && joiners.size === 0) reg.delete(hostId);
  }
}

/** The user ids currently synced to `hostId` (empty when none). */
export function joinersOf(hostId: number): number[] {
  return [...(registry().get(hostId) ?? [])];
}

/** The host a joiner is currently following, or null when they aren't joined. */
export function hostOf(joinerId: number): number | null {
  for (const [hostId, joiners] of registry()) {
    if (joiners.has(joinerId)) return hostId;
  }
  return null;
}

// ---- live SSE connection counting (for reaping stale joiners) ----
// A user can have several SSE connections open at once (multiple tabs / the
// player + the app-shell notifier). We only reap their watch-together membership
// when their LAST connection closes, so closing one tab doesn't break a session
// still open in another.

const CONN_KEY = Symbol.for("mediabox.watchTogether.conns");
type GlobalWithConns = typeof globalThis & { [CONN_KEY]?: Map<number, number> };

function connections(): Map<number, number> {
  const g = globalThis as GlobalWithConns;
  if (!g[CONN_KEY]) g[CONN_KEY] = new Map();
  return g[CONN_KEY];
}

/** Record that a user opened an SSE connection. */
export function connectionOpened(userId: number): void {
  connections().set(userId, (connections().get(userId) ?? 0) + 1);
}

/** Record that a user's SSE connection closed; returns true if it was their last. */
export function connectionClosed(userId: number): boolean {
  const c = connections();
  const next = (c.get(userId) ?? 1) - 1;
  if (next <= 0) {
    c.delete(userId);
    return true;
  }
  c.set(userId, next);
  return false;
}
