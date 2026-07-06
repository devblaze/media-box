/**
 * The running app version, sourced from package.json via next.config's
 * `env.NEXT_PUBLIC_APP_VERSION` (inlined at build time). Falls back to "dev"
 * when running outside a build (e.g. some test contexts).
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
