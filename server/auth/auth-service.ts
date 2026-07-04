import crypto from "node:crypto";
import { eq, gt, and } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSettings } from "@/server/settings/settings-service";
import { SESSION_COOKIE } from "@/server/auth/session-cookie";

const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days
export { SESSION_COOKIE };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

export function userCount(): number {
  return getDb().select({ id: schema.users.id }).from(schema.users).all().length;
}

export function createUser(username: string, password: string, role: "admin" | "user") {
  const db = getDb();
  return db
    .insert(schema.users)
    .values({
      username: username.trim().toLowerCase(),
      passwordHash: hashPassword(password),
      role,
      createdAt: new Date(),
    })
    .returning({ id: schema.users.id, username: schema.users.username, role: schema.users.role })
    .get();
}

export function authenticate(username: string, password: string) {
  const db = getDb();
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username.trim().toLowerCase()))
    .get();
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return user;
}

/** Username of the shared, low-privilege account kiosk/cast devices log in as. */
export const KIOSK_USERNAME = "kiosk";

/**
 * The id of the dedicated kiosk user, creating it on first use. Kiosk/cast URLs
 * exchange the kiosk token for a session bound to this account, so TV/tablet
 * devices can play channels without real credentials. It is a normal "user"-role
 * account (no admin access); rotating the kiosk token cuts off issued links.
 */
export function getOrCreateKioskUser(): number {
  const db = getDb();
  const existing = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, KIOSK_USERNAME))
    .get();
  if (existing) return existing.id;
  return createUser(KIOSK_USERNAME, crypto.randomBytes(24).toString("hex"), "user").id;
}

export function createSession(userId: number): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb().insert(schema.sessions).values({ token, userId, expiresAt }).run();
  return { token, expiresAt };
}

export function deleteSession(token: string) {
  getDb().delete(schema.sessions).where(eq(schema.sessions.token, token)).run();
}

export interface SessionUser {
  id: number;
  username: string;
  role: "admin" | "user";
}

/** Don't rewrite lastSeenAt more than once per minute per user (keeps write load trivial). */
const HEARTBEAT_THROTTLE_MS = 60_000;

export function getSessionUser(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
      lastSeenAt: schema.users.lastSeenAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.token, token), gt(schema.sessions.expiresAt, new Date())))
    .get();
  if (!row) return null;

  // Heartbeat: record activity so the admin Users panel can show online/offline.
  // Throttled so a burst of API calls doesn't hammer the single SQLite writer.
  const now = Date.now();
  if (!row.lastSeenAt || now - row.lastSeenAt.getTime() > HEARTBEAT_THROTTLE_MS) {
    db.update(schema.users)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(schema.users.id, row.id))
      .run();
  }

  return { id: row.id, username: row.username, role: row.role };
}

/**
 * Resolve the requesting user from a Request. In order: `X-Api-Key` header (=
 * admin), a `?key=<castToken>` query (= a low-privilege "cast" principal, so
 * Chromecast/AirPlay/kiosk devices that hold no cookie can still fetch media
 * URLs), then the session cookie. The cast token grants only user-level access —
 * admin routes still reject it.
 */
export function getRequestUser(request: Request): SessionUser | null {
  const settings = getSettings();

  const apiKey = request.headers.get("x-api-key");
  if (apiKey && apiKey === settings.apiKey) {
    return { id: 0, username: "api", role: "admin" };
  }

  const castKey = new URL(request.url).searchParams.get("key");
  if (castKey && settings.kioskToken && castKey === settings.kioskToken) {
    return { id: 0, username: "cast", role: "user" };
  }

  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9]{64})`));
  return getSessionUser(match?.[1]);
}
