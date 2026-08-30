/**
 * `fetch()` rejects with a bare **"fetch failed"** for every transport-level
 * problem — DNS, refused connection, TLS, timeout, unreachable network. The
 * actual reason is buried in `err.cause`, so an error that reaches a user or a
 * log as "fetch failed" tells them nothing about what to fix.
 *
 * These helpers dig the cause out and name it.
 */

interface CauseLike {
  code?: string;
  message?: string;
  cause?: CauseLike;
}

/** The `code` of the innermost cause (undici nests them a level or two deep). */
function causeCode(err: unknown): string | undefined {
  let node = err as CauseLike | undefined;
  for (let depth = 0; node && depth < 4; depth++) {
    if (typeof node.code === "string") return node.code;
    node = node.cause;
  }
  return undefined;
}

/** Host (and port) of a URL, for messages — falls back to the raw string. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A human explanation of why a fetch failed: "could not resolve api.torbox.app
 * (DNS)", "nothing is listening on 10.0.0.5:8080", … Returns null when the error
 * isn't a transport failure (an HTTP error response, a parse error, a bug), so
 * callers can keep their own message for those.
 */
export function describeFetchFailure(err: unknown, url: string): string | null {
  const host = hostOf(url);

  // AbortSignal.timeout() rejects with a DOMException, not a system error.
  if (err instanceof Error && err.name === "TimeoutError") {
    return `${host} did not respond in time`;
  }

  switch (causeCode(err)) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `could not resolve ${host} — check the container's DNS`;
    case "ECONNREFUSED":
      return `nothing is listening on ${host}`;
    case "ECONNRESET":
      return `${host} closed the connection`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `no route to ${host} from this container`;
    case "EPIPE":
      return `the connection to ${host} broke mid-request`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `timed out connecting to ${host}`;
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return `${host} accepted the connection then stopped responding`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `${host} uses a self-signed certificate`;
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
      return `${host}'s TLS certificate could not be verified`;
    case "UND_ERR_SOCKET":
      return `the connection to ${host} was lost`;
    default:
      break;
  }

  // Undici's own wording, with nothing useful underneath it.
  if (err instanceof Error && /^fetch failed$/i.test(err.message)) {
    return `could not reach ${host}`;
  }
  return null;
}

/**
 * Re-throwable version: `what` names the operation ("TorBox API", "the .torrent
 * from nyaa.si"), and the original error is preserved as `cause`. Errors that
 * aren't transport failures pass through with their own message intact.
 */
export function explainFetchFailure(err: unknown, url: string, what: string): Error {
  const described = describeFetchFailure(err, url);
  if (!described) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return new Error(`${what}: ${described}`, { cause: err });
}
