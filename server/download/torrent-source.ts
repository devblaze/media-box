import { explainFetchFailure } from "@/lib/fetch-error";

/**
 * What a release's download link actually turned out to be.
 *
 * Jackett and Prowlarr hand out `/dl/…` links for every result, but for a
 * magnet-only tracker (1337x, LimeTorrents, KAT, The Pirate Bay…) that link is a
 * **302 whose `Location:` is a `magnet:` URI**, not a torrent file. `fetch()`
 * cannot follow a redirect to a non-HTTP scheme — it rejects with a bare
 * "fetch failed" — so every grab from those indexers died before a download
 * client was ever contacted, and the error named neither the URL nor the reason.
 *
 * Resolving the link ourselves turns that case into the magnet it always was.
 */
export type TorrentSource =
  | { kind: "magnet"; magnetUrl: string }
  | { kind: "file"; buffer: Buffer };

const MAX_HOPS = 5;

/** Infohash out of a magnet URI (40-hex or 32-char base32), lowercased. */
export function infoHashFromMagnet(magnetUrl: string): string | undefined {
  const m = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Follow a release's download link to whatever it really points at: a torrent
 * file, or a magnet the indexer redirects to.
 *
 * Redirects are followed by hand (`redirect: "manual"`) precisely so a `magnet:`
 * hop can be recognised instead of blowing up the fetch.
 */
export async function resolveTorrentSource(
  url: string,
  opts: { timeoutMs?: number } = {}
): Promise<TorrentSource> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let current = url;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current.startsWith("magnet:")) return { kind: "magnet", magnetUrl: current };

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "media-box/0.1" },
      });
    } catch (err) {
      throw explainFetchFailure(err, current, "could not download the .torrent");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`the indexer sent HTTP ${res.status} with no redirect target`);
      }
      // Relative redirects are legal; resolve them against the current URL.
      current = location.startsWith("magnet:")
        ? location
        : new URL(location, current).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`the indexer returned HTTP ${res.status} for the .torrent`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    // Some indexers answer with the magnet as the body rather than redirecting.
    // A real torrent file is bencoded and starts with 'd'.
    const head = buffer.subarray(0, 7).toString("latin1");
    if (head.startsWith("magnet:")) {
      return { kind: "magnet", magnetUrl: buffer.toString("utf8").trim() };
    }
    if (buffer.length === 0) {
      throw new Error("the indexer returned an empty .torrent");
    }
    return { kind: "file", buffer };
  }

  throw new Error(`the indexer's download link redirected more than ${MAX_HOPS} times`);
}
