import { emitEvent, onEvent } from "@/server/events/bus";
import { getRequestUser } from "@/server/auth/auth-service";
import { connectionClosed, connectionOpened, hostOf, leave } from "@/server/watch-together/session";

export const dynamic = "force-dynamic";

// Server-Sent Events stream; the UI invalidates SWR caches on receipt.
export async function GET(request: Request) {
  const encoder = new TextEncoder();

  // Resolve the connection's user so targeted events (watch-together) can be
  // filtered to only their own connections. Untargeted events still fan out to
  // everyone. An unauthenticated connection sees only untargeted events. A
  // session-lookup hiccup must not 500 the whole live-update endpoint.
  let user: ReturnType<typeof getRequestUser> = null;
  try {
    user = getRequestUser(request);
  } catch {
    user = null;
  }
  if (user?.id) connectionOpened(user.id);

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // stream already closed
        }
      };
      send(`retry: 5000\n\n`);
      const unsubscribe = onEvent((event) => {
        // Targeted events (they carry a `targetUserId`) are delivered only to
        // that user's connections; everything else broadcasts unchanged.
        if ("targetUserId" in event && event.targetUserId !== user?.id) return;
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      const keepAlive = setInterval(() => send(`: keep-alive\n\n`), 25_000);
      keepAlive.unref?.();

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
        // When a joiner's LAST connection closes (e.g. tab hard-closed without a
        // proper Leave), reap their watch-together membership so the registry
        // can't grow unbounded and the host stops fanning sync events at a dead
        // connection — and gets a "left" toast.
        if (user?.id && connectionClosed(user.id)) {
          const host = hostOf(user.id);
          leave(user.id);
          if (host != null) {
            emitEvent({ type: "watch.peerLeft", targetUserId: host, joinerUsername: user.username });
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
