/**
 * Pushover notifications. A global Application API token (admin, in settings) plus
 * each user's personal user key (on the user row) enables per-user alerts — used to
 * tell a requester when their title becomes available. All best-effort: never throws.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSettings } from "@/server/settings/settings-service";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

export async function sendPushover(
  userKey: string,
  opts: { title?: string; message: string; url?: string; urlTitle?: string }
): Promise<{ ok: boolean; error?: string }> {
  const token = getSettings().pushoverAppToken;
  if (!token) return { ok: false, error: "Pushover app token not configured" };
  if (!userKey) return { ok: false, error: "No Pushover user key" };
  try {
    const body = new URLSearchParams({ token, user: userKey, message: opts.message });
    if (opts.title) body.set("title", opts.title);
    if (opts.url) body.set("url", opts.url);
    if (opts.urlTitle) body.set("url_title", opts.urlTitle);
    const res = await fetch(PUSHOVER_URL, { method: "POST", body });
    if (!res.ok) return { ok: false, error: `Pushover HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Pushover request failed" };
  }
}

/** Fire-and-forget: tell a user their requested title is now available. */
export function notifyRequestAvailable(userId: number, title: string): void {
  try {
    if (!getSettings().pushoverAppToken) return;
    const user = getDb()
      .select({ key: schema.users.pushoverUserKey })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    if (!user?.key) return;
    void sendPushover(user.key, {
      title: "media-box",
      message: `"${title || "Your request"}" is now available to watch.`,
    });
  } catch {
    /* best-effort — never block the import */
  }
}
