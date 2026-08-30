/**
 * Jackett/Prowlarr hand out a `/dl/…` link for every result, but for a
 * magnet-only tracker that link is a 302 whose `Location:` is a `magnet:` URI.
 * `fetch()` can't follow a redirect to a non-HTTP scheme, so every grab from
 * those indexers used to die with a bare "fetch failed" before a download client
 * was ever contacted. These pin the resolution that fixes it.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { infoHashFromMagnet, resolveTorrentSource } from "./torrent-source";

const MAGNET =
  "magnet:?xt=urn:btih:D0BF5A2F422128B037A965E9ACC9696EE5625513&dn=Grimm+S01E14&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce";

/** A bencoded torrent file starts with 'd'. */
const TORRENT = Buffer.from("d8:announce20:udp://tracker:1337/e");

function response(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}): Response {
  const headers = new Headers(init.headers ?? {});
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) < 400,
    headers,
    arrayBuffer: async () =>
      (init.body ?? Buffer.alloc(0)).buffer.slice(
        (init.body ?? Buffer.alloc(0)).byteOffset,
        (init.body ?? Buffer.alloc(0)).byteOffset + (init.body ?? Buffer.alloc(0)).byteLength
      ),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveTorrentSource", () => {
  test("a Jackett 302 to a magnet resolves to that magnet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ status: 302, headers: { location: MAGNET } }))
    );
    const source = await resolveTorrentSource("http://jackett:9117/dl/limetorrents/?path=x");
    expect(source).toEqual({ kind: "magnet", magnetUrl: MAGNET });
  });

  test("redirects are taken by hand, so fetch never sees the magnet hop", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      response({ status: 302, headers: { location: MAGNET } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await resolveTorrentSource("http://jackett:9117/dl/x");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  test("an actual torrent file comes back as bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 200, body: TORRENT })));
    const source = await resolveTorrentSource("http://jackett:9117/dl/x");
    expect(source.kind).toBe("file");
    if (source.kind === "file") expect(source.buffer.equals(TORRENT)).toBe(true);
  });

  test("an indexer that answers with the magnet as the body is handled too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ status: 200, body: Buffer.from(`${MAGNET}\n`) }))
    );
    const source = await resolveTorrentSource("http://jackett:9117/dl/x");
    expect(source).toEqual({ kind: "magnet", magnetUrl: MAGNET });
  });

  test("an http hop is followed, and a relative Location resolves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 301, headers: { location: "/dl/final" } }))
      .mockResolvedValueOnce(response({ status: 200, body: TORRENT }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveTorrentSource("http://jackett:9117/dl/x");
    expect(fetchMock.mock.calls[1][0]).toBe("http://jackett:9117/dl/final");
  });

  test("a redirect loop gives up instead of spinning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ status: 302, headers: { location: "http://jackett:9117/dl/x" } }))
    );
    await expect(resolveTorrentSource("http://jackett:9117/dl/x")).rejects.toThrow(/redirected more than/);
  });

  test("an HTTP error names the status instead of 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 410 })));
    await expect(resolveTorrentSource("http://jackett:9117/dl/x")).rejects.toThrow(
      /returned HTTP 410/
    );
  });

  test("a transport failure names the host and the reason", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed", { cause });
      })
    );
    await expect(resolveTorrentSource("http://jackett:9117/dl/x")).rejects.toThrow(
      /could not download the .torrent: nothing is listening on jackett:9117/
    );
  });

  test("a redirect with no Location is reported, not swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 302 })));
    await expect(resolveTorrentSource("http://jackett:9117/dl/x")).rejects.toThrow(
      /no redirect target/
    );
  });
});

describe("infoHashFromMagnet", () => {
  test("reads the 40-hex infohash, lowercased", () => {
    expect(infoHashFromMagnet(MAGNET)).toBe("d0bf5a2f422128b037a965e9acc9696ee5625513");
  });

  test("reads a base32 infohash", () => {
    expect(infoHashFromMagnet("magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")).toBe(
      "abcdefghijklmnopqrstuvwxyz234567"
    );
  });

  test("returns nothing for a magnet without one", () => {
    expect(infoHashFromMagnet("magnet:?dn=nothing")).toBeUndefined();
  });
});
