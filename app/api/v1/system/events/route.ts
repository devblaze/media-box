import { onEvent } from "@/server/events/bus";

export const dynamic = "force-dynamic";

// Server-Sent Events stream; the UI invalidates SWR caches on receipt.
export async function GET(request: Request) {
  const encoder = new TextEncoder();

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
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      const keepAlive = setInterval(() => send(`: keep-alive\n\n`), 25_000);
      keepAlive.unref?.();

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
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
