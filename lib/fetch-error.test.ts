/**
 * A grab that fails with "All download clients failed: fetch failed" tells the
 * admin nothing — every transport problem looks identical. These cover turning
 * undici's opaque rejection back into the reason it actually happened.
 */
import { describe, expect, test } from "vitest";
import { describeFetchFailure, explainFetchFailure } from "./fetch-error";

/** How undici rejects: a bare "fetch failed" with the real error as `cause`. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`${code} something`), { code });
  return new Error("fetch failed", { cause });
}

describe("describeFetchFailure", () => {
  test("names DNS failures and points at the container", () => {
    expect(describeFetchFailure(fetchFailed("ENOTFOUND"), "https://api.torbox.app/v1")).toBe(
      "could not resolve api.torbox.app — check the container's DNS"
    );
  });

  test("names a refused connection with host and port", () => {
    expect(describeFetchFailure(fetchFailed("ECONNREFUSED"), "http://10.0.0.5:8080/api")).toBe(
      "nothing is listening on 10.0.0.5:8080"
    );
  });

  test("distinguishes connect timeouts from a server that goes quiet", () => {
    expect(describeFetchFailure(fetchFailed("UND_ERR_CONNECT_TIMEOUT"), "https://x.test")).toMatch(
      /timed out connecting/
    );
    expect(describeFetchFailure(fetchFailed("UND_ERR_HEADERS_TIMEOUT"), "https://x.test")).toMatch(
      /stopped responding/
    );
  });

  test("recognises an AbortSignal.timeout rejection", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    expect(describeFetchFailure(err, "https://api.torbox.app/v1")).toBe(
      "api.torbox.app did not respond in time"
    );
  });

  test("digs the code out of a nested cause chain", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const middle = new Error("socket error", { cause: inner });
    expect(describeFetchFailure(new Error("fetch failed", { cause: middle }), "http://h:1/")).toBe(
      "nothing is listening on h:1"
    );
  });

  test("still says something useful for an unrecognised transport error", () => {
    expect(describeFetchFailure(new Error("fetch failed"), "https://nyaa.si/x.torrent")).toBe(
      "could not reach nyaa.si"
    );
  });

  test("leaves non-transport errors alone", () => {
    expect(describeFetchFailure(new Error("HTTP 404"), "https://nyaa.si")).toBeNull();
    expect(describeFetchFailure(new TypeError("bad json"), "https://nyaa.si")).toBeNull();
  });
});

describe("explainFetchFailure", () => {
  test("prefixes the operation and keeps the original as cause", () => {
    const original = fetchFailed("ENOTFOUND");
    const err = explainFetchFailure(original, "https://api.torbox.app/v1/api", "TorBox API unreachable");
    expect(err.message).toBe(
      "TorBox API unreachable: could not resolve api.torbox.app — check the container's DNS"
    );
    expect(err.cause).toBe(original);
  });

  test("passes a real HTTP-level error through untouched", () => {
    const original = new Error("the indexer returned HTTP 403 for the .torrent");
    expect(explainFetchFailure(original, "https://nyaa.si", "could not download the .torrent")).toBe(
      original
    );
  });
});
