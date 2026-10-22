import { withMarketTicket } from "./binance-gateway-config.mjs";
import { withAbort } from "./system-proxy-fetch.mjs";
import { MARKET_WIRE_CODEC } from "./market-wire-codec.mjs";

export class BinancePrivatePermitError extends Error {
  constructor(message, { status = 503, retryAfterMs = 0, code = "PRIVATE_EGRESS_UNAVAILABLE" } = {}) {
    super(message);
    this.name = "BinancePrivatePermitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

function mergeHeaders(initHeaders, authorization) {
  const headers = new Headers(initHeaders || {});
  headers.set("Authorization", authorization);
  headers.set("X-Velune-Client", "windows-desktop");
  return headers;
}

function privateRouteMetadata(input) {
  const url = new URL(String(input));
  if (!["https://api.binance.com", "https://fapi1.binance.com"].includes(url.origin)) {
    throw new TypeError("private Binance permit target is not allowed");
  }
  return Object.freeze({
    marketType: url.origin === "https://fapi1.binance.com" || url.pathname.startsWith("/fapi/") ? "futures" : "spot",
    pathname: url.pathname,
    hasSymbol: url.searchParams.has("symbol"),
  });
}

export function createBinanceGatewayClient({ config, apiClient, fetchImpl = globalThis.fetch } = {}) {
  if (!config || !apiClient || typeof fetchImpl !== "function") throw new TypeError("config, apiClient and fetchImpl are required");
  const authorization = async (forceRefresh = false) => `Bearer ${await apiClient.getTrustedAccessToken({ forceRefresh })}`;
  const allowedOrigins = new Set([config.marketOrigin, config.marketFreeOrigin].filter(Boolean));
  const validateTarget = (input) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.has(url.origin)) {
      throw new TypeError("Untrusted market gateway origin");
    }
    return url;
  };
  let marketRoute = null;
  const responseOrigins = new WeakMap();
  const authenticatedFetch = async (url, init = {}, initialToken) => {
    validateTarget(url);
    if (init.signal?.aborted) throw init.signal.reason;
    const token = initialToken ?? await authorization();
    if (init.signal?.aborted) throw init.signal.reason;
    let response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      headers: mergeHeaders(init.headers, token),
    });
    if (response.status !== 401 || init.signal?.aborted) return response;
    try { await response.body?.cancel?.(); } catch {}
    const refreshedToken = await authorization(true);
    if (init.signal?.aborted) throw init.signal.reason;
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      headers: mergeHeaders(init.headers, refreshedToken),
    });
    return response;
  };
  const marketFetch = async (input, init = {}, { discovery = false } = {}) => {
    const url = validateTarget(input);
    const token = await authorization();
    const cached = !discovery && marketRoute?.token === token && marketRoute.expiresAt > Date.now() ? marketRoute.origin : url.origin;
    let target = new URL(url.pathname + url.search, cached);
    const headers = new Headers(init.headers || {});
    headers.set("X-Velune-Market-Routing", "1");
    for (let hop = 0; hop < 2; hop++) {
      const response = await authenticatedFetch(target.href, { ...init, headers }, token);
      if (response.status !== 409) {
        responseOrigins.set(response, target.origin);
        return response;
      }
      const route = await response.json();
      if (hop !== 0 || route?.error !== "MARKET_ROUTE_REQUIRED") throw new Error("Market route unavailable");
      const next = validateTarget(route.marketOrigin);
      if (next.href !== `${next.origin}/` || next.origin === target.origin) throw new TypeError("Invalid market route");
      target = new URL(url.pathname + url.search, next.origin);
      marketRoute = { token, origin: next.origin, expiresAt: Date.now() + 60_000 };
    }
    throw new Error("Market route unavailable");
  };
  const controlJson = async (url, init = {}, market = false) => {
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException("Gateway control request timed out", "TimeoutError")),
      config.gatewayControlTimeoutMs || 12_000);
    try {
      const response = await withAbort(market ? marketFetch(url, { ...init, signal }, { discovery: true }) : authenticatedFetch(url, { ...init, signal }), signal);
      const payload = await withAbort(response.json().catch(() => null), signal);
      return { response, payload, origin: responseOrigins.get(response) };
    } finally { clearTimeout(timer); }
  };
  const marketStreamConnection = async ({ marketType, combined = false, streamClass = "market" } = {}) => {
    const normalizedMarket = String(marketType || "").toLowerCase();
    if (!["spot", "futures"].includes(normalizedMarket)) throw new TypeError("invalid marketType");
    const normalizedClass = String(streamClass || "market").toLowerCase();
    if (!["market", "public"].includes(normalizedClass)) throw new TypeError("invalid streamClass");
    const classSuffix = normalizedClass === "public" && normalizedMarket === "futures" ? "Public" : "";
    const key = combined ? `${normalizedMarket}${classSuffix}Combined` : `${normalizedMarket}${classSuffix}`;
    const endpoint = config.gatewayPublicWebSocket[key] || config.gatewayPublicWebSocket[combined ? `${normalizedMarket}Combined` : normalizedMarket];
    if (!endpoint || !config.ticketUrl) throw new Error("Velune market gateway is not configured");
    // Count from before the request, not after its body arrives. A suspended
    // event loop can resume with a 201 whose one-use ticket has already expired.
    const requestedAt = Date.now();
    const { response, payload, origin } = await controlJson(config.ticketUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ codecs: [MARKET_WIRE_CODEC], ticketProtocol: 2 }), cache: "no-store",
    }, true);
    if (!response.ok || !payload?.ticket) throw new Error(`Velune market ticket failed: HTTP ${response.status}`);
    const advertisedTtl = Number(payload.expiresInMs ?? 30_000);
    const ttlMs = Number.isFinite(advertisedTtl) ? Math.min(30_000, Math.max(0, advertisedTtl)) : 0;
    const ticketExpiresAt = requestedAt + ttlMs;
    if (ticketExpiresAt <= Date.now() + 1_000) {
      throw Object.assign(new Error("Market WebSocket ticket expired before connect"), { code: "WS_TICKET_EXPIRED" });
    }
    const routedEndpoint = new URL(endpoint);
    routedEndpoint.host = new URL(origin || config.marketOrigin).host;
    return Object.freeze({ url: withMarketTicket(routedEndpoint.href, payload.ticket), ticketExpiresAt });
  };
  return Object.freeze({
    async fetch(url, init = {}) {
      if (!config.marketGatewayEnabled) throw new Error("Velune market gateway is not configured");
      return marketFetch(url, init);
    },
    marketStreamConnection,
    async marketStreamEndpoint(params) { return (await marketStreamConnection(params)).url; },
    async privateRequestPermit(targetUrl, { signal } = {}) {
      if (!config.privateProxyEnabled || !config.privatePermitUrl) throw new Error("Velune private egress is not configured");
      const { response, payload } = await controlJson(config.privatePermitUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(privateRouteMetadata(targetUrl)),
        cache: "no-store",
        signal,
      });
      if (!response.ok || !payload?.permitToken || !payload?.proxyUrl || !payload?.permitId) {
        throw new BinancePrivatePermitError(`Velune private egress permit failed: HTTP ${response.status}`, {
          status: response.status,
          retryAfterMs: Number(payload?.retryAfterMs || 0),
          code: String(payload?.error || "PRIVATE_EGRESS_UNAVAILABLE"),
        });
      }
      return payload;
    },
    async reportPrivateUsage(report = {}) {
      if (!config.privateUsageUrl) return false;
      const { response } = await controlJson(config.privateUsageUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permitId: String(report.permitId || ""),
          status: Number(report.status || 0),
          usedWeight1m: Number(report.usedWeight1m || 0),
          retryAfterMs: Number(report.retryAfterMs || 0),
        }),
        cache: "no-store",
      });
      return response.ok;
    },
  });
}

export { privateRouteMetadata };
