import os from "node:os";
import { getSettings } from "@/server/settings/settings-service";

/**
 * Working out the address a PHONE should use to reach this server.
 *
 * A QR code is only useful if it points somewhere the scanning device can
 * actually reach, which is never `localhost` and rarely the container's own
 * interface address. The request's own Host header is the best evidence we
 * have: whatever the admin typed to get here is, by definition, an address that
 * works from a machine on this network.
 */

export type AddressSource = "setting" | "request" | "interface" | "fallback";

export interface ServerAddress {
  /** Origin another device on this network should use, no trailing slash. */
  baseUrl: string;
  source: AddressSource;
  /** iOS refuses an itms-services install from anything but trusted HTTPS. */
  https: boolean;
  /** Every LAN address this process can see, offered as alternatives in the UI. */
  candidates: string[];
}

const DEFAULT_PORT = process.env.PORT || "7878";

/** The host part of a `Host` header, with the port removed. An IPv6 literal
 *  arrives bracketed and is full of colons, so it cannot be split on one. */
function hostnameOf(host: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return (bracketed ? bracketed[1] : host.split(":")[0]).toLowerCase();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

/** Non-internal IPv4 addresses of this host, most-likely-LAN first.
 *  Inside Docker's default bridge network this is the CONTAINER's address
 *  (172.x), which no phone can reach — hence its low precedence below. */
function interfaceAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  // Private ranges a phone plausibly shares with the server come first.
  const isLan = (ip: string) =>
    ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return out.sort((a, b) => Number(isLan(b)) - Number(isLan(a)));
}

/**
 * Resolve the origin to put in a QR code, in order of how much we trust it:
 * an explicit setting, then the address the admin is already browsing on, then
 * this host's own LAN interface.
 */
export function resolveServerAddress(headers: Headers): ServerAddress {
  const requestHost = headers.get("x-forwarded-host") || headers.get("host") || "";
  // Prefer the port the admin actually reached us on over the configured one:
  // they agree in the container, and where they don't, the working one is the
  // port that just carried this request.
  const port = requestHost.split(":")[1] || DEFAULT_PORT;
  const candidates = interfaceAddresses().map((ip) => `http://${ip}:${port}`);

  const configured = getSettings().appDownloadBaseUrl.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      return {
        baseUrl: url.origin,
        source: "setting",
        https: url.protocol === "https:",
        candidates,
      };
    } catch {
      // Unparseable override — fall through rather than break the page.
    }
  }

  // Behind a reverse proxy the original host and scheme live in the forwarded
  // headers. Without one they are absent, and Host is already what the admin
  // typed. The scheme is only ever knowable from the forwarded header: inside
  // the container the connection is plain http even when TLS terminated outside.
  const host = requestHost;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  if (host) {
    if (!isLoopback(hostnameOf(host))) {
      return {
        baseUrl: `${proto}://${host}`,
        source: "request",
        https: proto === "https",
        candidates,
      };
    }
  }

  // The admin is on localhost, so the Host header is useless to a phone.
  if (candidates.length > 0) {
    return { baseUrl: candidates[0], source: "interface", https: false, candidates };
  }
  return {
    baseUrl: host ? `${proto}://${host}` : `http://localhost:${DEFAULT_PORT}`,
    source: "fallback",
    https: proto === "https",
    candidates,
  };
}
