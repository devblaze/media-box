import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSettings } from "@/server/settings/settings-service";
import {
  authenticateByName,
  logout,
  type JellyfinConnection,
} from "./jellyfin-client";

export type JellyfinLink = typeof schema.jellyfinLinks.$inferSelect;

export function getJellyfinUrl(): string {
  return getSettings().jellyfinUrl.trim().replace(/\/$/, "");
}

export function getLink(userId: number): JellyfinLink | undefined {
  return getDb()
    .select()
    .from(schema.jellyfinLinks)
    .where(eq(schema.jellyfinLinks.userId, userId))
    .get();
}

export function getAllLinks(): JellyfinLink[] {
  return getDb().select().from(schema.jellyfinLinks).all();
}

export function connectionFor(link: JellyfinLink, url = getJellyfinUrl()): JellyfinConnection {
  return {
    url,
    userId: link.jellyfinUserId,
    accessToken: link.accessToken,
    deviceId: link.deviceId,
  };
}

/**
 * Log the user into Jellyfin with their own credentials and store the resulting
 * token as this user's link (replacing any previous link). The password is only
 * ever forwarded to Jellyfin — never persisted here.
 */
export async function linkAccount(
  userId: number,
  username: string,
  password: string
): Promise<JellyfinLink> {
  const url = getJellyfinUrl();
  if (!url) throw new Error("No Jellyfin server configured — ask an admin to set the URL first.");
  const deviceId = randomBytes(12).toString("hex");
  const auth = await authenticateByName(url, deviceId, username, password);

  const db = getDb();
  const now = new Date();
  const values = {
    userId,
    jellyfinUserId: auth.User.Id,
    jellyfinUsername: auth.User.Name,
    accessToken: auth.AccessToken,
    deviceId,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: now,
  };
  db.insert(schema.jellyfinLinks)
    .values(values)
    .onConflictDoUpdate({ target: schema.jellyfinLinks.userId, set: values })
    .run();
  return getLink(userId)!;
}

/** Remove the user's link, revoking the Jellyfin token best-effort. */
export async function unlinkAccount(userId: number): Promise<void> {
  const link = getLink(userId);
  if (!link) return;
  const url = getJellyfinUrl();
  if (url) {
    try {
      await logout(connectionFor(link, url));
    } catch {
      // Server unreachable or token already dead — the local unlink still stands.
    }
  }
  getDb().delete(schema.jellyfinLinks).where(eq(schema.jellyfinLinks.userId, userId)).run();
}

export function recordSyncResult(userId: number, error: string | null): void {
  getDb()
    .update(schema.jellyfinLinks)
    .set({ lastSyncAt: new Date(), lastSyncError: error })
    .where(eq(schema.jellyfinLinks.userId, userId))
    .run();
}
