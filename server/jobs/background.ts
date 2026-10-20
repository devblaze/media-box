import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks work done by scheduled/background commands, so shared resources (the TMDB
 * rate limit) can let a person waiting on a page go first. On globalThis because
 * the scheduler and the route handlers can load separate copies of this module.
 */
const KEY = Symbol.for("mediabox.background");
type GlobalWithStore = typeof globalThis & { [KEY]?: AsyncLocalStorage<true> };

function store(): AsyncLocalStorage<true> {
  const g = globalThis as GlobalWithStore;
  g[KEY] ??= new AsyncLocalStorage<true>();
  return g[KEY];
}

/** Run `fn` (and everything it awaits) as background work. */
export function runInBackground<T>(fn: () => Promise<T>): Promise<T> {
  return store().run(true, fn);
}

/** Whether the current call chain started in a background command. */
export function isBackground(): boolean {
  return store().getStore() === true;
}
