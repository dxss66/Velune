import dns from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function routeError(message, code = "EHOSTUNREACH") {
  return Object.assign(new Error(message), { code });
}

// Race anonymous health checks, never account requests, tickets or CONNECT
// permits. The URL, Host and TLS identity always remain the gateway's origin.
export function probeGatewayRoute({ origin, service, address, signal, requestImpl = https.request }) {
  return new Promise((resolve, reject) => {
    const request = requestImpl(new URL("/health", origin), {
      method: "GET",
      agent: false,
      family: 4,
      servername: new URL(origin).hostname,
      rejectUnauthorized: true,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      signal,
      lookup: (_hostname, options, callback) => callback(null,
        options?.all ? [{ address, family: 4 }] : address, 4),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          const error = routeError("Gateway health response is too large");
          reject(error);
          request.destroy(error);
        }
        else chunks.push(Buffer.from(chunk));
      });
      response.once("error", reject);
      response.once("aborted", () => reject(routeError("Gateway health response was interrupted")));
      response.once("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 || body.status !== "ok" || body.service !== service) {
            throw routeError("Gateway health identity or status did not match");
          }
          resolve(address);
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.end();
  });
}

export function createGatewayRouteLookup({
  routes = [],
  lookupImpl = dns.lookup,
  probeImpl = probeGatewayRoute,
  timeoutMs = 2500,
  cacheTtlMs = 30_000,
  failureCooldownMs = 30_000,
  now = Date.now,
} = {}) {
  const routeMap = new Map();
  for (const route of routes) {
    const url = new URL(route.origin);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || !route.service) {
      throw new TypeError("Gateway route requires a standard HTTPS origin and health service identity");
    }
    const candidates = [...new Set([...(route.candidates || []), url.hostname])];
    if (candidates.length > 9 || candidates.some((host) => typeof host !== "string" || (!HOST.test(host) && isIP(host) !== 4))) {
      throw new TypeError("Gateway routes require at most eight trusted DNS/IPv4 candidates");
    }
    routeMap.set(url.hostname, { ...route, origin: url.origin, candidates });
  }
  const cache = new Map();
  const pending = new Map();
  const failures = new Map();
  const active = new Set();
  let closed = false;

  function select(hostname, route) {
    const entry = cache.get(hostname);
    if (entry && entry.expires > now()) return Promise.resolve(entry.address);
    if (pending.has(hostname)) return pending.get(hostname);
    const controller = new AbortController();
    active.add(controller);
    const selection = new Promise((resolve, reject) => {
      let settled = false;
      let remainingDns = route.candidates.length;
      let remainingProbes = 0;
      const addresses = new Set();
      const deferred = [];
      let deferredTimer = null;
      const finish = (error, address) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(deferredTimer);
        controller.signal.removeEventListener("abort", aborted);
        if (!error) cache.set(hostname, { address, expires: now() + cacheTtlMs });
        controller.abort();
        active.delete(controller);
        if (error) reject(error); else resolve(address);
      };
      const exhausted = () => {
        if (remainingDns || remainingProbes || settled) return;
        // Prefer another edge after a transport failure. If every alternative
        // is unavailable, still recheck the old address rather than enforcing
        // an artificial outage for the duration of its cooldown.
        if (deferred.length) deferred.splice(0).forEach(startProbe);
        else finish(routeError("No healthy gateway route is available"));
      };
      const aborted = () => finish(routeError("Gateway route selection closed", "ECANCELED"));
      const timer = setTimeout(() => finish(routeError("Gateway route selection timed out", "ETIMEDOUT")), timeoutMs);
      controller.signal.addEventListener("abort", aborted, { once: true });
      const startProbe = (address) => {
        remainingProbes++;
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw routeError("Route probe cancelled", "ECANCELED");
          return probeImpl({ ...route, address, signal: controller.signal });
        }).then(() => finish(null, address), () => {
          remainingProbes--;
          exhausted();
        });
      };
      const resolved = (error, records) => {
        remainingDns--;
        if (settled) return;
        if (!error) {
          for (const record of records || []) {
            const address = record.address;
            if (isIP(address) !== 4 || addresses.has(address) || addresses.size >= 16) continue;
            addresses.add(address);
            if ((failures.get(hostname)?.get(address) || 0) > now()) {
              deferred.push(address);
              // A hanging DNS provider must not prevent recovery through the
              // only healthy pinned address after its transient failure.
              deferredTimer ??= setTimeout(() => {
                if (!settled) deferred.splice(0).forEach(startProbe);
              }, Math.min(500, timeoutMs / 2));
            } else startProbe(address);
          }
        }
        exhausted();
      };
      for (const candidate of route.candidates) {
        if (isIP(candidate) === 4) resolved(null, [{ address: candidate, family: 4 }]);
        else {
          try { lookupImpl(candidate, { family: 4, all: true, verbatim: true }, resolved); }
          catch (error) { resolved(error); }
        }
      }
    });
    pending.set(hostname, selection);
    // Do not let completion of an invalidated selection clear a newer one.
    selection.then(() => {
      if (pending.get(hostname) === selection) pending.delete(hostname);
    }, () => {
      if (pending.get(hostname) === selection) pending.delete(hostname);
    });
    return selection;
  }

  const lookup = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof options === "number") options = { family: options };
    const host = String(hostname).toLowerCase();
    if (closed) { queueMicrotask(() => callback(routeError("Gateway route lookup is closed", "ECANCELED"))); return; }
    const route = routeMap.get(host);
    if (!route || Number(options?.family) === 6) { lookupImpl(hostname, options, callback); return; }
    select(host, route).then((address) => {
      if (options?.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    }, (error) => callback(error));
  };
  lookup.handles = (hostname) => routeMap.has(String(hostname).toLowerCase());
  lookup.invalidate = (hostname, failedAddress) => {
    const host = String(hostname).toLowerCase();
    if (!routeMap.has(host)) return;
    const entry = cache.get(host);
    const address = failedAddress || entry?.address;
    if (isIP(address || "") === 4) {
      const failed = failures.get(host) || new Map();
      for (const [ip, expires] of failed) if (expires <= now()) failed.delete(ip);
      failed.set(address, now() + failureCooldownMs);
      while (failed.size > 16) failed.delete(failed.keys().next().value);
      failures.set(host, failed);
    }
    // A long-lived socket can fail after a newer route was selected. Preserve
    // that healthy route instead of poisoning unrelated concurrent requests.
    if (!failedAddress || entry?.address === failedAddress) cache.delete(host);
  };
  lookup.close = () => {
    closed = true;
    cache.clear();
    failures.clear();
    for (const controller of active) controller.abort();
  };
  return lookup;
}
