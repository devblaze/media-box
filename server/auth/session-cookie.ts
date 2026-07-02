/**
 * Session cookie name — kept in its own dependency-free module so `proxy.ts`
 * (the Next 16 proxy/middleware) can import it WITHOUT pulling in the database
 * layer (better-sqlite3) that auth-service.ts depends on.
 */
export const SESSION_COOKIE = "mediabox_session";
