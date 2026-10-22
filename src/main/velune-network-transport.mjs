import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { SocksClient } from "socks";
import { Agent, fetch as transportFetch } from "undici";
import { createVeluneNetworkPolicy, veluneRoute, networkFingerprint, NETWORK_POLICY_PATH } from "./velune-network-policy.mjs";
import { withAbort } from "./system-proxy-fetch.mjs";

function connectHttpProxy(proxy, address, port, signal) {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === "https:" ? https : http;
    const authority = `${address}:${port}`;
    const request = client.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT", path: authority, headers: { Host: authority }, agent: false, signal,
      maxHeaderSize: 16 * 1024, rejectUnauthorized: true });
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error("Configured proxy rejected CONNECT"), { code: "VELUNE_PROXY_CONNECT", status: response.statusCode }));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

// Both CONNECT and SOCKS receive the selected IP, not the public domain (whose
// DNS still points at GA). TLS SNI and certificate verification use the domain.
export async function openVeluneSocket(urlValue, decision, { signal, connectTimeoutMs = 8_000, ca } = {}) {
  const url = new URL(String(urlValue));
  const controller = new AbortController();
  const overallSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Velune connection timed out"), { code: "ETIMEDOUT" })), connectTimeoutMs);
  timer.unref?.();
  let lastError;
  try {
    for (const address of decision.addresses) {
      overallSignal.throwIfAborted();
      const connectSignal = decision.addresses.length > 1
        ? AbortSignal.any([overallSignal, AbortSignal.timeout(Math.max(1, Math.floor(connectTimeoutMs / decision.addresses.length)))]) : overallSignal;
      let raw;
      let secure;
      const abort = () => { secure?.destroy(); raw?.destroy(); };
      connectSignal.addEventListener("abort", abort, { once: true });
      try {
        const port = Number(url.port || 443);
        if (decision.proxyUrl) {
          const proxy = new URL(decision.proxyUrl);
          if (["http:", "https:"].includes(proxy.protocol)) {
            raw = await connectHttpProxy(proxy, address, port, connectSignal);
          } else {
            raw = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port), signal: connectSignal });
            await once(raw, "connect", { signal: connectSignal });
            await withAbort(SocksClient.createConnection({ existing_socket: raw,
              proxy: { host: proxy.hostname, port: Number(proxy.port), type: proxy.protocol === "socks4:" ? 4 : 5 },
              command: "connect", destination: { host: address, port }, timeout: connectTimeoutMs }), connectSignal);
          }
        }
        connectSignal.throwIfAborted();
        secure = tls.connect({ ...(raw ? { socket: raw } : { host: address, port }),
          servername: url.hostname, rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
          ...(ca ? { ca } : {}) });
        await once(secure, "secureConnect", { signal: connectSignal });
        secure.setNoDelay(true);
        secure.setTimeout(0);
        return secure;
      } catch (error) {
        secure?.destroy();
        raw?.destroy();
        lastError = error;
      } finally {
        connectSignal.removeEventListener("abort", abort);
      }
    }
    overallSignal.throwIfAborted();
    throw lastError || new Error("No Velune route is available");
  } finally { clearTimeout(timer); }
}

export function createElectronProxyResolver({ getSession, refreshMs = 5_000, timeoutMs = 3_000, now = Date.now }) {
  let initialized;
  let refresh;
  let refreshedAt = 0;
  return async (url) => {
    const ses = getSession();
    const signal = AbortSignal.timeout(timeoutMs);
    if (!initialized) {
      initialized = Promise.resolve(ses.setProxy({ mode: "system" })).catch((error) => { initialized = null; throw error; });
    }
    await withAbort(initialized, signal);
    if (now() - refreshedAt >= refreshMs && !refresh) {
      refresh = Promise.resolve(ses.forceReloadProxyConfig()).then(() => { refreshedAt = now(); }).finally(() => { refresh = null; });
    }
    if (refresh) await withAbort(refresh, signal);
    return withAbort(ses.resolveProxy(url), signal);
  };
}

export function createVeluneNetworkTransport({ resolveProxy, fallbackFetch = globalThis.fetch, onDiagnostic, policyOptions = {}, socketOptions = {}, fetchImpl = transportFetch, openSocket = openVeluneSocket, marketRoutePollMs = 5_000, now = Date.now } = {}) {
  const dispatchers = new Map();
  const marketRouteWatchers = new Set();
  const fingerprint = policyOptions.fingerprint || networkFingerprint;
  let closed = false;
  function dispatcher(url, decision) {
    const key = `${new URL(url).origin}|${decision.proxyUrl || "DIRECT"}|${decision.addresses.join(",")}`;
    if (!dispatchers.has(key)) {
      const agent = new Agent({ connect: (_options, callback) => {
        openSocket(url, decision, socketOptions).then((socket) => callback(null, socket), callback);
      }, connections: 8, pipelining: 1, headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 10_000 });
      dispatchers.set(key, agent);
      if (dispatchers.size > 32) {
        const oldest = dispatchers.keys().next().value;
        void dispatchers.get(oldest).close().catch(() => {});
        dispatchers.delete(oldest);
      }
    }
    return dispatchers.get(key);
  }
  const policy = createVeluneNetworkPolicy({ resolveProxy, onDiagnostic, ...policyOptions,
    probeRegion: policyOptions.probeRegion || (async (url, route) => {
      const probe = new URL(NETWORK_POLICY_PATH, url);
      probe.protocol = "https:";
      // A new TCP connection observes the current TUN/VPN egress. A pooled
      // connection opened before an interface change would report stale geography.
      const probeAgent = new Agent({ connections: 1, connect: (_opts, callback) => {
        openSocket(probe, { proxyUrl: null, addresses: [route.ordinary] }, { ...socketOptions, connectTimeoutMs: 3_000 })
          .then((socket) => callback(null, socket), callback);
      } });
      try {
        const response = await fetchImpl(probe, { method: "GET", redirect: "error", credentials: "omit",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(3_000), dispatcher: probeAgent });
        if (!response.ok) { await response.body?.cancel(); throw new Error("Network policy unavailable"); }
        let body = "";
        for await (const chunk of response.body) {
          body += Buffer.from(chunk).toString("utf8");
          if (body.length > 4096) throw new Error("Network policy is too large");
        }
        return JSON.parse(body);
      } finally { await probeAgent.destroy(); }
    }),
  });
  async function fetch(urlValue, init = {}) {
    if (closed) throw new Error("Velune network transport is closed");
    const url = String(urlValue instanceof Request ? urlValue.url : urlValue);
    if (!veluneRoute(url)) return fallbackFetch(urlValue, init);
    // A Request body is consumed once. Business POSTs are never retried here.
    let options = urlValue instanceof Request ? { method: urlValue.method, headers: urlValue.headers,
      body: urlValue.body, signal: urlValue.signal, redirect: urlValue.redirect, ...init } : { ...init };
    let target = url;
    for (let redirects = 0; ; redirects++) {
      const decision = await policy.resolve(target, { signal: options.signal });
      const response = await fetchImpl(target, { ...options, duplex: "half", redirect: "manual", dispatcher: dispatcher(target, decision) });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get("location") || options.redirect === "manual") return response;
      if (options.redirect === "error" || redirects >= 10) { await response.body?.cancel(); throw new TypeError("Velune redirect rejected"); }
      const next = new URL(response.headers.get("location"), target);
      const previous = new URL(target);
      await response.body?.cancel();
      if (next.protocol !== "https:" || next.username || next.password) throw new TypeError("Unsafe Velune redirect");
      const headers = new Headers(options.headers || {});
      if (next.origin !== previous.origin) for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
      const method = String(options.method || "GET").toUpperCase();
      if (response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST") {
        options = { ...options, method: "GET", body: undefined };
        for (const name of ["content-type", "content-length", "content-encoding"]) headers.delete(name);
      } else if (options.body?.getReader || options.body?.pipe) throw new TypeError("Cannot replay a streamed request after redirect");
      options = { ...options, headers };
      if (!veluneRoute(next)) return fallbackFetch(next.href, options);
      target = next.href;
    }
  }
  async function connect(url, options = {}) {
    const decision = await policy.resolve(url, options);
    return openSocket(url, decision, { ...socketOptions, ...options });
  }
  async function marketSocketRoute(url, signal) {
    // Capture before awaiting: a change during the handshake must also cause a
    // reconnect, even when both networks select the same physical destination.
    const network = fingerprint();
    const decision = await policy.resolve(url, { signal });
    return { decision, key: JSON.stringify([network, decision.proxyUrl, decision.addresses]) };
  }
  function watchMarketRoute(socket, url, initialKey) {
    const controller = new AbortController();
    let stopped = false, checking = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      controller.abort();
      marketRouteWatchers.delete(stop);
    };
    const check = async () => {
      if (stopped || checking || socket.readyState !== 1) return;
      checking = true;
      let changed = false;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]);
        const route = await marketSocketRoute(url, signal);
        changed = route.key !== initialKey;
      } catch {
        // An unresolved proxy must not leave the old direct GA stream running.
        changed = true;
      } finally { checking = false; }
      if (!changed || stopped || socket.readyState !== 1) return;
      stop();
      // Hub owns fresh tickets, subscriptions and recovery. Do not reconnect
      // this socket with a consumed ticket, or replay any model protocol.
      try { socket.emit("velune-route-change"); } finally { socket.terminate(); }
    };
    const timer = setInterval(() => { void check(); }, Math.max(10, Number(marketRoutePollMs) || 5_000));
    timer.unref?.();
    marketRouteWatchers.add(stop);
    void check();
    return stop;
  }
  function webSocketClass(WebSocketImpl) {
    return class VeluneRoutedWebSocket extends WebSocketImpl {
      constructor(url, options = {}) {
        if (!veluneRoute(url)) { super(url, options); return; }
        const agent = new https.Agent({ keepAlive: false });
        const controller = new AbortController();
        const watchRoute = false;
        const ticketExpiresAt = options.veluneMarketTicketExpiresAt;
        const checkTicket = () => {
          if (Number.isFinite(ticketExpiresAt) && ticketExpiresAt <= now() + 1_000) {
            throw Object.assign(new Error("Market WebSocket ticket expired before upgrade"), { code: "WS_TICKET_EXPIRED" });
          }
        };
        let initialRoute, stopWatching;
        agent.createConnection = (_opts, callback) => {
          const pending = Promise.resolve().then(() => {
            checkTicket();
            return watchRoute ? marketSocketRoute(url, controller.signal).then((route) => {
              initialRoute = route;
              checkTicket();
              return openSocket(url, route.decision, { ...socketOptions, signal: controller.signal });
            }) : connect(url, { signal: controller.signal });
          });
          pending.then(socket => {
            try { controller.signal.throwIfAborted(); checkTicket(); }
            catch (error) { socket.destroy(); callback(error); return; }
            callback(null, socket);
          }, callback);
        };
        // The market server controls the rollout cohort. Offering the extension
        // does not enable it when the server keeps its default percentage at 0.
        // Model/business sockets retain their existing compression policy.
        super(url, { ...options, ...(watchRoute ? { perMessageDeflate: {
          clientNoContextTakeover: true, serverNoContextTakeover: true,
          concurrencyLimit: 2, threshold: 1024,
        } } : {}), agent });
        this.once("open", () => {
          if (!watchRoute) return;
          if (closed) { this.terminate(); return; }
          stopWatching = watchMarketRoute(this, url, initialRoute.key);
        });
        const cleanup = () => { stopWatching?.(); controller.abort(); agent.destroy(); };
        this.once("close", cleanup);
        this.once("error", cleanup);
      }
    };
  }
  return Object.freeze({ fetch, connect, policy, webSocketClass,
    close() {
      closed = true;
      for (const stop of marketRouteWatchers) stop();
      for (const agent of dispatchers.values()) void agent.destroy().catch(() => {});
      dispatchers.clear();
    },
  });
}
