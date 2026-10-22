import os from "node:os";
import { withAbort } from "./system-proxy-fetch.mjs";

export const NETWORK_POLICY_PATH = "/.well-known/velune-network";
export const NETWORK_POLICY_VERSION = "20260927.1";
// Local build: the first-party edge route table has been removed.
// Every outbound request now goes straight to the public Internet.
export const VELUNE_NETWORK_ROUTES = Object.freeze({});

export function veluneRoute(urlValue) {
  const url = new URL(String(urlValue));
  if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password || (url.port && url.port !== "443")) return null;
  return VELUNE_NETWORK_ROUTES[url.hostname] || null;
}

// PAC is evaluated for the original URL, including its path, before pinning an IP.
// Do not silently turn an unavailable configured proxy into a direct connection.
export function parseResolvedProxy(value) {
  const first = String(value || "").split(";")[0].trim();
  if (/^DIRECT$/i.test(first)) return null;
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+([^\s]+)$/i.exec(first);
  if (!match) throw Object.assign(new Error("System proxy route is unavailable or unsupported"), { code: "VELUNE_PROXY_UNRESOLVED" });
  const scheme = { PROXY: "http", HTTPS: "https", SOCKS: "socks4", SOCKS4: "socks4", SOCKS5: "socks5" }[match[1].toUpperCase()];
  const proxy = new URL(`${scheme}://${match[2]}`);
  if (!proxy.hostname || !/:\d+$/.test(match[2]) || proxy.username || proxy.password || proxy.pathname !== "" && proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw Object.assign(new Error("Invalid system proxy endpoint"), { code: "VELUNE_PROXY_UNRESOLVED" });
  }
  return proxy.href;
}

export function networkFingerprint() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter((a) => !a.internal).map((a) => `${name}:${a.family}:${a.address}:${a.netmask}`)).sort().join("|");
}

export function createVeluneNetworkPolicy({ resolveProxy, probeRegion, now = Date.now, fingerprint = networkFingerprint, ttlMs = 30_000, onDiagnostic = () => {} } = {}) {
  if (typeof resolveProxy !== "function" || typeof probeRegion !== "function") throw new TypeError("proxy resolver and region probe are required");
  const regions = new Map();
  const inflight = new Map();
  let generation = 0;
  const emit = (entry) => { try { onDiagnostic({ event: "velune-route", ...entry }); } catch {} };
  async function region(url, route, signal) {
    const key = `${generation}|${url.hostname}|${fingerprint()}`;
    const cached = regions.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!inflight.has(key)) {
      const probe = Promise.resolve().then(() => probeRegion(url, route)).then((data) => {
        if (data?.schemaVersion !== 1 || data?.service !== "velune-network-policy" || !["CN", "OTHER", "UNKNOWN"].includes(data.egressRegion)) {
          throw new Error("Invalid Velune network policy response");
        }
        // Server can disable acceleration immediately; it cannot redirect credentials
        // to arbitrary hosts. Physical targets remain the audited client allowlist.
        const value = data.egressRegion === "CN" && data.accelerationEnabled === true ? "CN" : data.egressRegion === "UNKNOWN" ? "UNKNOWN" : "OTHER";
        regions.set(key, { value, expiresAt: now() + Math.min(ttlMs, Math.max(1_000, Number(data.ttlSeconds || 30) * 1000)) });
        if (regions.size > 24) regions.delete(regions.keys().next().value);
        return value;
      }).catch(() => {
        regions.set(key, { value: "UNKNOWN", expiresAt: now() + 5_000 });
        return "UNKNOWN";
      }).finally(() => inflight.delete(key));
      inflight.set(key, probe);
    }
    return withAbort(inflight.get(key), signal);
  }
  return Object.freeze({
    async resolve(urlValue, { signal } = {}) {
      signal?.throwIfAborted();
      const url = new URL(String(urlValue));
      const route = veluneRoute(url);
      if (!route) throw new TypeError("Velune routing requires an allowlisted HTTPS origin");
      const proxyUrl = parseResolvedProxy(await withAbort(resolveProxy(url.href), signal));
      const egressRegion = proxyUrl ? "PROXY" : route.accelerated.length ? await region(url, route, signal) : "UNPROBED";
      signal?.throwIfAborted();
      const accelerated = route.accelerated.length > 0 && !proxyUrl && egressRegion === "CN";
      const decision = Object.freeze({ hostname: url.hostname, proxyUrl, egressRegion,
        route: accelerated ? "hong-kong-ga" : "ordinary", addresses: accelerated ? route.accelerated : [route.ordinary] });
      emit({ hostname: url.hostname, route: decision.route, egressRegion, proxy: Boolean(proxyUrl) });
      return decision;
    },
    invalidate() { generation++; regions.clear(); },
  });
}
