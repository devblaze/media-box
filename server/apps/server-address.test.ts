import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * A QR code is only worth anything if it points at an address the scanning
 * phone can reach. These pin the order of evidence: what the admin configured,
 * then the address they are demonstrably already reaching the server on, then
 * this host's own interfaces as a last resort.
 */

let configured = "";
vi.mock("@/server/settings/settings-service", () => ({
  getSettings: () => ({ appDownloadBaseUrl: configured }),
}));

let interfaces: Record<string, NetworkInterfaceInfo[]> = {};
vi.mock("node:os", () => ({
  default: { networkInterfaces: () => interfaces },
  networkInterfaces: () => interfaces,
}));

import { resolveServerAddress } from "./server-address";

/** An IPv4 entry shaped the way node reports one. */
function iface(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

const headers = (init: Record<string, string>) => new Headers(init);

beforeEach(() => {
  configured = "";
  interfaces = {};
});

describe("resolveServerAddress", () => {
  test("uses the address the admin is already browsing on", () => {
    // Whatever they typed to get here demonstrably reaches this server from a
    // machine on this network, which is exactly what the phone needs.
    interfaces = { eth0: [iface("172.17.0.2")] };
    const address = resolveServerAddress(headers({ host: "192.168.1.10:7878" }));
    expect(address.baseUrl).toBe("http://192.168.1.10:7878");
    expect(address.source).toBe("request");
  });

  test("falls back to a LAN interface when the admin is on localhost", () => {
    // localhost in a QR code is a code that only works on the server itself.
    interfaces = { eth0: [iface("192.168.1.10")], lo: [iface("127.0.0.1", true)] };
    const address = resolveServerAddress(headers({ host: "localhost:7878" }));
    expect(address.baseUrl).toBe("http://192.168.1.10:7878");
    expect(address.source).toBe("interface");
  });

  test("treats every loopback spelling as unusable", () => {
    interfaces = { eth0: [iface("192.168.1.10")] };
    for (const host of ["localhost:7878", "127.0.0.1:7878", "[::1]:7878"]) {
      expect(resolveServerAddress(headers({ host })).source).toBe("interface");
    }
  });

  test("an explicit setting beats everything else", () => {
    configured = "https://media.example.org";
    const address = resolveServerAddress(headers({ host: "192.168.1.10:7878" }));
    expect(address.baseUrl).toBe("https://media.example.org");
    expect(address.source).toBe("setting");
    expect(address.https).toBe(true);
  });

  test("an unparseable setting falls through instead of breaking the page", () => {
    configured = "not a url";
    const address = resolveServerAddress(headers({ host: "192.168.1.10:7878" }));
    expect(address.source).toBe("request");
  });

  test("honours a reverse proxy's forwarded host and scheme", () => {
    const address = resolveServerAddress(
      headers({
        host: "media-box:7878",
        "x-forwarded-host": "media.example.org",
        "x-forwarded-proto": "https",
      })
    );
    expect(address.baseUrl).toBe("https://media.example.org");
    expect(address.https).toBe(true);
  });

  test("takes the first entry of a forwarded-proto chain", () => {
    // Chained proxies append, so the client-facing scheme is the leftmost one.
    const address = resolveServerAddress(
      headers({ host: "media.example.org", "x-forwarded-proto": "https, http" })
    );
    expect(address.https).toBe(true);
  });

  test("assumes plain http when no proxy says otherwise", () => {
    // TLS terminates outside the container, so the connection this process sees
    // is always http — only the forwarded header can prove otherwise, and iOS
    // installs hinge on getting this right.
    expect(resolveServerAddress(headers({ host: "192.168.1.10:7878" })).https).toBe(false);
  });

  test("offers private-range addresses ahead of anything else", () => {
    // A phone shares a private range with the server; a public or docker-ish
    // address is far less likely to be the one that works.
    interfaces = {
      eth0: [iface("100.64.3.2")],
      eth1: [iface("192.168.1.10")],
      lo: [iface("127.0.0.1", true)],
    };
    const address = resolveServerAddress(headers({ host: "192.168.1.10:7878" }));
    expect(address.candidates[0]).toContain("192.168.1.10");
    expect(address.candidates).toHaveLength(2);
  });

  test("ignores loopback interfaces when listing candidates", () => {
    interfaces = { lo: [iface("127.0.0.1", true)] };
    const address = resolveServerAddress(headers({ host: "localhost:7878" }));
    expect(address.candidates).toEqual([]);
    expect(address.source).toBe("fallback");
  });
});
