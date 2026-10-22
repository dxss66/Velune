import { DEFAULT_DIRECT_ENDPOINTS } from "./binance-gateway-config.mjs";
import { discardBinanceResponse, fetchBinanceResponse } from "./binance-response-body.mjs";
import { withAbort } from "./system-proxy-fetch.mjs";
import {
  BINANCE_REQUEST_GOVERNOR_MANAGED,
  parseBinanceRetryAfterMs,
} from "./binance-request-governor.mjs";

const ACCOUNT_ORIGINS = new Set([
  "https://api.binance.com",
  "https://fapi1.binance.com",
  "https://fapi.binance.com",
]);
const ROUTE_BLOCKING_STATUSES = new Set([403, 451]);
const ROUTE_KINDS = Object.freeze(["public", "private"]);
const MARKET_TYPES = Object.freeze(["spot", "futures"]);

export const BINANCE_DIRECT_ROUTE_FAILED = "BINANCE_DIRECT_ROUTE_FAILED";

export class BinanceDirectRouteError extends Error {
  constructor(message = "Direct Binance route is unavailable", options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "BinanceDirectRouteError";
    this.code = BINANCE_DIRECT_ROUTE_FAILED;
    this.marketType = options.marketType || null;
  }
}

function normalizedMarketType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "spot" || normalized === "futures") return normalized;
  throw new TypeError("unsupported Binance market type");
}

function publicMarketType(url) {
  if (url.origin === DEFAULT_DIRECT_ENDPOINTS.publicRest.futures) return "futures";
  if (url.origin === DEFAULT_DIRECT_ENDPOINTS.publicRest.spot) return "spot";
  throw new TypeError("public Binance router target is not allowed");
}

function privateMarketType(url) {
  if (!ACCOUNT_ORIGINS.has(url.origin)) throw new TypeError("private Binance router target is not allowed");
  return url.origin === "https://fapi1.binance.com" || url.origin === "https://fapi.binance.com" || url.pathname.startsWith("/fapi/")
    ? "futures"
    : "spot";
}

function routeKey(kind, marketType) {
  return `${kind}:${marketType}`;
}

function isRouteBlockingResponse(response) {
  return ROUTE_BLOCKING_STATUSES.has(Number(response?.status || 0));
}

function isPublicRouteFailureResponse(response, method = "GET") {
  const status = Number(response?.status || 0);
  // A direct 418/429 is an egress failure for public market data. Leaving it
  // as a successful race result prevents the configured market gateway from
  // taking over, so every renderer sees Binance's cooldown instead of a
  // cached or separately budgeted market response. Gateway responses use the
  // separate `isGatewayRetryableResponse` policy below and keep their existing
  // "healthy direct wins" rule.
  return isRouteBlockingResponse(response)
    || status === 418
    || status === 429
    || (method === "GET" && status >= 500);
}

function decorateRouteResponse(response, route) {
  if (!response || typeof response !== "object") return response;
  const headers = new Headers(response.headers || {});
  const gateway = route === "public-gateway" || route === "private-gateway";
  headers.set("x-velune-binance-route", route);
  headers.set("x-velune-binance-egress", route === "direct" ? "local" : route === "public-gateway" ? "velune-public" : "velune-private");
  if (!headers.has("x-velune-rate-limit-source") && [418, 429].includes(Number(response.status || 0))) {
    headers.set("x-velune-rate-limit-source", gateway ? "gateway-downstream" : "direct-binance");
  }
  // Undici cancels an unread, unlocked body when its original Response is
  // collected. Transferring the bare stream to a new Response loses that owner.
  // A streaming pipe locks the source until completion/cancellation and keeps
  // the decorated response independently readable and cloneable by the governor.
  const body = response.body?.pipeThrough(new TransformStream()) ?? null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isGatewayRetryableResponse(response, url) {
  const status = Number(response?.status || 0);
  const cacheStatus = String(response?.headers?.get?.("x-velune-cache") || "").trim().toUpperCase();
  // Older market gateways do not expose these public statistics routes. A
  // gateway 404 must not win the race against a working Binance response.
  const missingIndexRoute = status === 404 && /^\/futures\/data\/(?:globalLongShortAccountRatio|topLongShortAccountRatio|topLongShortPositionRatio)$/.test(url?.pathname || "");
  return missingIndexRoute || cacheStatus === "STALE" || status === 429 || status >= 500 || status === 0;
}

class BinanceGatewayResponseError extends Error {
  constructor(response) {
    super(`Velune market gateway returned HTTP ${response?.status || 0}`);
    this.name = "BinanceGatewayResponseError";
    this.response = response;
  }
}

function websocketKey(marketType, combined, streamClass = "market") {
  const suffix = streamClass === "public" && marketType === "futures" ? "Public" : "";
  return combined ? `${marketType}${suffix}Combined` : `${marketType}${suffix}`;
}

function normalizedStreamClass(value) {
  const normalized = String(value || "market").trim().toLowerCase();
  if (normalized === "market" || normalized === "public") return normalized;
  throw new TypeError("unsupported Binance WebSocket stream class");
}

async function fetchWithDeadline(fetchImpl, input, init, timeoutMs) {
  if (init?.signal?.aborted) throw init.signal.reason || new DOMException("The operation was aborted", "AbortError");
  const timeoutController = new AbortController();
  const signals = [timeoutController.signal, init?.signal].filter(Boolean);
  const signal = typeof AbortSignal?.any === "function"
    ? AbortSignal.any(signals)
    : timeoutController.signal;
  const forwardAbort = typeof AbortSignal?.any !== "function" && init?.signal
    ? () => timeoutController.abort(init.signal.reason)
    : null;
  if (forwardAbort) init.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer;
  let rejectCallerAbort;
  const request = fetchBinanceResponse(fetchImpl, input, { ...init, signal });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Direct Binance attempt timed out");
      error.name = "TimeoutError";
      timeoutController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const callerAbort = init?.signal
    ? new Promise((_, reject) => {
      rejectCallerAbort = () => reject(init.signal.reason || new DOMException("The operation was aborted", "AbortError"));
      init.signal.addEventListener("abort", rejectCallerAbort, { once: true });
    })
    : null;
  timer.unref?.();
  try {
    return await Promise.race([request, deadline, callerAbort].filter(Boolean));
  } finally {
    clearTimeout(timer);
    if (forwardAbort) init.signal.removeEventListener("abort", forwardAbort);
    if (rejectCallerAbort) init.signal.removeEventListener("abort", rejectCallerAbort);
  }
}

function linkedAbortController(parentSignal) {
  const controller = new AbortController();
  return {
    controller,
    // Keep caller cancellation connected after headers win the hedge. Native
    // composition does not require removing a forwarding listener prematurely.
    signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
  };
}

export class BinanceNetworkRouter {
  constructor({
    config,
    directFetch = globalThis.fetch,
    gatewayClient = null,
    privateProxyFetch = null,
    now = Date.now,
    cooldownBaseMs = 15_000,
    cooldownMaxMs = 5 * 60_000,
    healthyTtlMs = 30_000,
    routePreferenceTtlMs = config?.routePreferenceTtlMs || 30 * 60_000,
    slowRoutePreferenceTtlMs = 5 * 60_000,
    publicHedgeDelayMs = config?.publicHedgeDelayMs || 200,
    backgroundProbeIntervalMs = config?.backgroundProbeIntervalMs || 45_000,
    initialState = null,
    onStateChange = null,
    directCooldownRemaining = null,
    onDirectRateLimit = null,
  } = {}) {
    if (!config || typeof directFetch !== "function") throw new TypeError("config and directFetch are required");
    this.config = config;
    this.directFetch = directFetch;
    this.gatewayClient = gatewayClient;
    this.privateProxyFetch = privateProxyFetch;
    this.now = now;
    this.cooldownBaseMs = Math.max(1_000, Number(cooldownBaseMs) || 15_000);
    this.cooldownMaxMs = Math.max(this.cooldownBaseMs, Number(cooldownMaxMs) || 5 * 60_000);
    this.healthyTtlMs = Math.max(1_000, Number(healthyTtlMs) || 30_000);
    this.routePreferenceTtlMs = Math.max(1_000, Number(routePreferenceTtlMs) || 30 * 60_000);
    this.slowRoutePreferenceTtlMs = Math.max(
      1_000,
      Math.min(this.routePreferenceTtlMs, Number(slowRoutePreferenceTtlMs) || 5 * 60_000),
    );
    this.publicHedgeDelayMs = Math.max(25, Number(publicHedgeDelayMs) || 200);
    this.backgroundProbeIntervalMs = Math.max(1_000, Number(backgroundProbeIntervalMs) || 45_000);
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.directCooldownRemaining = directCooldownRemaining;
    this.onDirectRateLimit = onDirectRateLimit;
    this.directRateLimits = new Map();
    this.states = new Map();
    this.backgroundProbeInitialTimer = null;
    this.backgroundProbeTimer = null;
    this.backgroundProbeRunning = false;
    this.restoreState(initialState);
  }

  currentTimeMs() {
    const value = typeof this.now === "function" ? this.now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value) || Date.now();
  }

  state(key) {
    let value = this.states.get(key);
    if (!value) {
      value = {
        failures: 0,
        cooldownUntil: 0,
        healthyUntil: 0,
        gatewayPreferredUntil: 0,
        probing: false,
      };
      this.states.set(key, value);
    }
    return value;
  }

  fallbackAvailable(kind) {
    return kind === "public"
      ? Boolean(this.config.marketGatewayEnabled && this.gatewayClient)
      : Boolean(this.config.privateProxyEnabled && this.privateProxyFetch);
  }

  acquire(kind, marketType) {
    const mode = this.config.routingMode || this.config.mode || "direct";
    if (mode === "gateway") return { route: "gateway", state: null, probe: false };
    if (mode === "direct" || !this.fallbackAvailable(kind)) return { route: "direct", state: null, probe: false };
    const state = this.state(routeKey(kind, marketType));
    const currentMs = this.currentTimeMs();
    if (
      (kind === "public" && this.directRateLimitRemaining(marketType) > 0)
      ||
      state.gatewayPreferredUntil > currentMs
      || state.cooldownUntil > currentMs
      || state.probing
    ) return { route: "gateway", state, probe: false };
    return { route: "direct", state, probe: false };
  }

  markDirectSuccess(kind, marketType) {
    if (this.directRateLimitRemaining(marketType) > 0) return;
    const state = this.state(routeKey(kind, marketType));
    const changed = state.failures > 0 || state.cooldownUntil > 0 || state.gatewayPreferredUntil > 0;
    state.failures = 0;
    state.cooldownUntil = 0;
    state.healthyUntil = this.currentTimeMs() + this.healthyTtlMs;
    state.gatewayPreferredUntil = 0;
    state.probing = false;
    if (changed) this.notifyStateChange();
  }

  markDirectFailure(kind, marketType) {
    const state = this.state(routeKey(kind, marketType));
    const currentMs = this.currentTimeMs();
    state.failures = Math.min(20, state.failures + 1);
    const cooldownMs = Math.min(this.cooldownMaxMs, this.cooldownBaseMs * 2 ** Math.min(state.failures - 1, 6));
    state.cooldownUntil = currentMs + cooldownMs;
    state.healthyUntil = 0;
    state.gatewayPreferredUntil = Math.max(
      state.gatewayPreferredUntil,
      currentMs + this.routePreferenceTtlMs,
    );
    state.probing = false;
    this.notifyStateChange();
  }

  markDirectSlow(kind, marketType) {
    const state = this.state(routeKey(kind, marketType));
    const currentMs = this.currentTimeMs();
    state.cooldownUntil = Math.max(state.cooldownUntil, currentMs + this.cooldownBaseMs);
    state.healthyUntil = 0;
    state.gatewayPreferredUntil = Math.max(
      state.gatewayPreferredUntil,
      currentMs + this.slowRoutePreferenceTtlMs,
    );
    state.probing = false;
    this.notifyStateChange();
  }

  releaseProbe(state) {
    if (state) state.probing = false;
  }

  restoreState(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    const currentMs = this.currentTimeMs();
    for (const kind of ROUTE_KINDS) {
      for (const marketType of MARKET_TYPES) {
        const key = routeKey(kind, marketType);
        const persisted = snapshot[key];
        if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) continue;
        const cooldownUntil = Math.max(0, Number(persisted.cooldownUntil) || 0);
        const gatewayPreferredUntil = Math.max(0, Number(persisted.gatewayPreferredUntil) || 0);
        if (cooldownUntil <= currentMs && gatewayPreferredUntil <= currentMs) continue;
        this.states.set(key, {
          failures: Math.max(0, Math.min(20, Math.trunc(Number(persisted.failures) || 0))),
          cooldownUntil,
          healthyUntil: 0,
          gatewayPreferredUntil,
          probing: false,
        });
      }
    }
  }

  persistedState() {
    return Object.freeze(Object.fromEntries([...this.states].flatMap(([key, state]) => {
      if (state.failures <= 0 && state.cooldownUntil <= 0 && state.gatewayPreferredUntil <= 0) return [];
      return [[key, Object.freeze({
        failures: state.failures,
        cooldownUntil: state.cooldownUntil,
        gatewayPreferredUntil: state.gatewayPreferredUntil,
      })]];
    })));
  }

  notifyStateChange() {
    if (!this.onStateChange) return;
    try {
      const pending = this.onStateChange(this.persistedState());
      Promise.resolve(pending).catch(() => {});
    } catch {}
  }

  gatewayPublicUrl(url) {
    if (!this.config.marketOrigin) throw new Error("Velune market gateway is not configured");
    const gatewayUrl = new URL(url.href);
    const origin = new URL(this.config.marketOrigin);
    gatewayUrl.protocol = origin.protocol;
    gatewayUrl.host = origin.host;
    return gatewayUrl.href;
  }

  async publicGatewayFetch(url, init) {
    if (!this.gatewayClient) throw new Error("Velune market gateway is not configured");
    return fetchBinanceResponse(this.gatewayClient.fetch.bind(this.gatewayClient), this.gatewayPublicUrl(url), init);
  }

  canUsePublicGateway() {
    return (this.config.routingMode || this.config.mode) !== "direct" && this.fallbackAvailable("public");
  }

  async publicGatewayOnlyFetch(input, init = {}) {
    const url = new URL(String(input));
    publicMarketType(url);
    if (
      String(init.method || "GET").toUpperCase() !== "GET"
      || new Headers(init.headers).has("x-mbx-apikey")
      || url.searchParams.has("signature")
    ) {
      throw new TypeError("public gateway permits unsigned GET only");
    }
    if (!this.canUsePublicGateway()) throw new Error("Public gateway fallback unavailable");
    return decorateRouteResponse(await this.publicGatewayFetch(url, init), "public-gateway");
  }

  directRateLimitRemaining(marketType) {
    return Math.max(0,
      Number(this.directRateLimits.get(marketType) || 0) - this.currentTimeMs(),
      Number(this.directCooldownRemaining?.(marketType) || 0));
  }

  observeDirectRateLimit(marketType, response, { managed = false } = {}) {
    if (![418, 429].includes(Number(response?.status))) return;
    const nowMs = this.currentTimeMs();
    const retryMs = parseBinanceRetryAfterMs(response, nowMs) ?? (response.status === 418 ? 300_000 : 60_000);
    this.directRateLimits.set(marketType, Math.max(Number(this.directRateLimits.get(marketType) || 0), nowMs + Math.max(1_000, retryMs)));
    if (!managed) {
      this.onDirectRateLimit?.(marketType, response, nowMs);
    }
  }

  async publicHedgedFetch(url, init, marketType) {
    init?.signal?.throwIfAborted();
    const directLink = linkedAbortController(init?.signal);
    const gatewayLink = linkedAbortController(init?.signal);
    let openGatewayGate;
    let gatewayGateOpened = false;
    let directFailed = false;
    let gatewayWon = false;
    let directResponse;
    let gatewayResponse;
    let selectedResponse;
    const gatewayGate = new Promise((resolve) => { openGatewayGate = resolve; });
    const openGateway = () => {
      if (gatewayGateOpened) return;
      gatewayGateOpened = true;
      openGatewayGate();
    };
    const hedgeTimer = setTimeout(openGateway, this.publicHedgeDelayMs);
    hedgeTimer.unref?.();

    const directPromise = (async () => {
      try {
        const response = await this.directRequest("public", url.href, {
          ...init,
          signal: directLink.signal,
        });
        if (directLink.signal.aborted) {
          discardBinanceResponse(response, directLink.signal.reason);
          throw directLink.signal.reason;
        }
        if (isPublicRouteFailureResponse(response)) {
          discardBinanceResponse(response);
          directFailed = true;
          this.markDirectFailure("public", marketType);
          openGateway();
          throw new BinanceDirectRouteError(`Direct Binance market route returned HTTP ${response.status}`, { marketType });
        }
        directResponse = decorateRouteResponse(response, "direct");
        return { route: "direct", response: directResponse };
      } catch (error) {
        if (init?.signal?.aborted) throw init.signal.reason || error;
        if (gatewayWon && directLink.controller.signal.aborted) throw error;
        if (!directFailed) {
          directFailed = true;
          this.markDirectFailure("public", marketType);
        }
        openGateway();
        throw error;
      }
    })();

    const gatewayPromise = (async () => {
      await gatewayGate;
      if (gatewayLink.signal.aborted) {
        throw gatewayLink.signal.reason || new DOMException("The operation was aborted", "AbortError");
      }
      const upstream = await this.publicGatewayFetch(url, {
        ...init,
        signal: gatewayLink.signal,
      });
      if (gatewayLink.signal.aborted) {
        discardBinanceResponse(upstream, gatewayLink.signal.reason);
        throw gatewayLink.signal.reason;
      }
      const response = decorateRouteResponse(upstream, "public-gateway");
      gatewayResponse = response;
      if (isGatewayRetryableResponse(response, url)) throw new BinanceGatewayResponseError(response);
      return { route: "gateway", response };
    })();

    try {
      const winner = await withAbort(Promise.any([directPromise, gatewayPromise]), init?.signal);
      selectedResponse = winner.response;
      if (winner.route === "direct") {
        this.markDirectSuccess("public", marketType);
        gatewayLink.controller.abort(new Error("Direct Binance route won the market request race"));
        openGateway();
      } else {
        gatewayWon = true;
        if (!directFailed) this.markDirectSlow("public", marketType);
        directLink.controller.abort(new Error("Velune gateway won the market request race"));
      }
      return winner.response;
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason || error;
      const errors = Array.isArray(error?.errors) ? error.errors : [];
      const fallbackResponse = errors.find((item) => item?.response)?.response;
      if (fallbackResponse) {
        selectedResponse = fallbackResponse;
        return fallbackResponse;
      }
      throw errors.at(-1) || error;
    } finally {
      clearTimeout(hedgeTimer);
      if (!selectedResponse || selectedResponse !== directResponse) {
        directLink.controller.abort(new Error("Direct Binance response was not selected"));
        discardBinanceResponse(directResponse);
      }
      if (!selectedResponse || selectedResponse !== gatewayResponse) {
        gatewayLink.controller.abort(new Error("Gateway Binance response was not selected"));
        discardBinanceResponse(gatewayResponse);
      }
      openGateway();
    }
  }

  async directRequest(kind, input, init) {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const marketType = kind === "private" ? privateMarketType(url) : publicMarketType(url);
    const cooldownMs = this.directRateLimitRemaining(marketType);
    if (cooldownMs > 0) {
      return new Response('{"code":-1003,"msg":"Direct Binance egress is cooling down"}', {
        status: 429,
        headers: { "retry-after": String(Math.ceil(cooldownMs / 1_000)), "x-velune-rate-limit-source": "direct-binance" },
      });
    }
    const mode = this.config.routingMode || this.config.mode || "direct";
    const response = mode !== "auto" || !this.fallbackAvailable(kind)
      ? await fetchBinanceResponse(this.directFetch, input, init)
      : await fetchWithDeadline(this.directFetch, input, init, this.config.directAttemptTimeoutMs || 3_000);
    this.observeDirectRateLimit(marketType, response, {
      managed: init?.[BINANCE_REQUEST_GOVERNOR_MANAGED] === true,
    });
    return response;
  }

  async publicFetch(input, init = {}) {
    init.signal?.throwIfAborted();
    const url = new URL(String(input));
    const marketType = publicMarketType(url);
    const decision = this.acquire("public", marketType);
    const method = String(init.method || "GET").toUpperCase();
    const mode = this.config.routingMode || this.config.mode || "direct";
    if (decision.route === "gateway") {
      let gatewayResponse = null;
      try {
        gatewayResponse = decorateRouteResponse(await this.publicGatewayFetch(url, init), "public-gateway");
        if (this.directRateLimitRemaining(marketType) > 0) return gatewayResponse;
        if (!isGatewayRetryableResponse(gatewayResponse, url) || mode !== "auto") return gatewayResponse;
      } catch (gatewayError) {
        if (init?.signal?.aborted || mode !== "auto") throw gatewayError;
        if (this.directRateLimitRemaining(marketType) > 0) throw gatewayError;
        try {
          const directResponse = await this.directRequest("public", url.href, init);
          if (isPublicRouteFailureResponse(directResponse, method)) {
            discardBinanceResponse(directResponse);
            if (gatewayResponse) return gatewayResponse;
            throw new Error(`Direct Binance market route returned HTTP ${directResponse.status}`);
          }
          this.markDirectSuccess("public", marketType);
          discardBinanceResponse(gatewayResponse);
          return decorateRouteResponse(directResponse, "direct");
        } catch (error) {
          if (init?.signal?.aborted) { discardBinanceResponse(gatewayResponse); throw init.signal.reason || error; }
          if (gatewayResponse) return gatewayResponse;
          throw gatewayError;
        }
      }
      try {
        const directResponse = await this.directRequest("public", url.href, init);
        if (isPublicRouteFailureResponse(directResponse, method)) {
          discardBinanceResponse(directResponse);
          return gatewayResponse;
        }
        this.markDirectSuccess("public", marketType);
        discardBinanceResponse(gatewayResponse);
        return decorateRouteResponse(directResponse, "direct");
      } catch (error) {
        if (init?.signal?.aborted) { discardBinanceResponse(gatewayResponse); throw init.signal.reason || error; }
        return gatewayResponse;
      }
    }
    const directLeaseHealthy = Boolean(decision.state?.healthyUntil > this.currentTimeMs());
    if (method === "GET" && mode === "auto" && this.fallbackAvailable("public") && !directLeaseHealthy) {
      return this.publicHedgedFetch(url, init, marketType);
    }
    try {
      const response = await this.directRequest("public", url.href, init);
      if (!isPublicRouteFailureResponse(response, method)) {
        this.markDirectSuccess("public", marketType);
        return decorateRouteResponse(response, "direct");
      }
      if (!this.fallbackAvailable("public")) return decorateRouteResponse(response, "direct");
      discardBinanceResponse(response);
      this.markDirectFailure("public", marketType);
      return decorateRouteResponse(await this.publicGatewayFetch(url, init), "public-gateway");
    } catch (error) {
      if (init?.signal?.aborted || !this.fallbackAvailable("public")) throw error;
      this.markDirectFailure("public", marketType);
      return decorateRouteResponse(await this.publicGatewayFetch(url, init), "public-gateway");
    } finally {
      this.releaseProbe(decision.probe ? decision.state : null);
    }
  }

  async privateFetch(input, init = {}) {
    init.signal?.throwIfAborted();
    const url = new URL(String(input));
    const marketType = privateMarketType(url);
    const method = String(init.method || "GET").toUpperCase();
    if (method !== "GET") throw new TypeError("private Binance router permits GET only");
    const decision = this.acquire("private", marketType);
    if (decision.route === "gateway") return decorateRouteResponse(await fetchBinanceResponse(this.privateProxyFetch, url.href, init), "private-gateway");
    try {
      const response = await this.directRequest("private", url.href, init);
      if (!isRouteBlockingResponse(response)) {
        this.markDirectSuccess("private", marketType);
        return decorateRouteResponse(response, "direct");
      }
      if (!this.fallbackAvailable("private")) return decorateRouteResponse(response, "direct");
      discardBinanceResponse(response);
      this.markDirectFailure("private", marketType);
      throw new BinanceDirectRouteError("Direct Binance account route was blocked", { marketType });
    } catch (error) {
      if (error?.code === BINANCE_DIRECT_ROUTE_FAILED) throw error;
      if (init?.signal?.aborted || !this.fallbackAvailable("private")) throw error;
      this.markDirectFailure("private", marketType);
      throw new BinanceDirectRouteError("Direct Binance account route failed", { cause: error, marketType });
    } finally {
      this.releaseProbe(decision.probe ? decision.state : null);
    }
  }

  async probePublicDirect(marketType, timeoutMs = this.config.directAttemptTimeoutMs || 3_000) {
    const pingPath = marketType === "futures" ? "/fapi/v1/ping" : "/api/v3/ping";
    const pingUrl = new URL(pingPath, `${this.config.publicRest[marketType]}/`).href;
    const response = await fetchWithDeadline(
      (input, init) => this.directRequest("public", input, init),
      pingUrl,
      { method: "GET", cache: "no-store" },
      timeoutMs,
    );
    discardBinanceResponse(response);
    if (Number(response?.status) !== 200) throw new Error(`Direct Binance probe returned HTTP ${response?.status || 0}`);
    return response;
  }

  async probePrivateDirect(marketType) {
    const pingPath = marketType === "futures" ? "/fapi/v1/ping" : "/api/v3/ping";
    const origin = marketType === "futures" ? "https://fapi1.binance.com" : "https://api.binance.com";
    const response = await fetchWithDeadline(
      (input, init) => this.directRequest("private", input, init),
      new URL(pingPath, `${origin}/`).href,
      { method: "GET", cache: "no-store" },
      this.config.directAttemptTimeoutMs || 3_000,
    );
    discardBinanceResponse(response);
    if (Number(response?.status) !== 200) throw new Error(`Direct Binance account probe returned HTTP ${response?.status || 0}`);
    return response;
  }

  async runBackgroundProbes() {
    if (this.backgroundProbeRunning) return;
    const mode = this.config.routingMode || this.config.mode || "direct";
    if (mode !== "auto") return;
    const currentMs = this.currentTimeMs();
    const targets = [];
    for (const kind of ROUTE_KINDS) {
      if (!this.fallbackAvailable(kind)) continue;
      for (const marketType of MARKET_TYPES) {
        if (this.directRateLimitRemaining(marketType) > 0) continue;
        const state = this.state(routeKey(kind, marketType));
        if (
          state.gatewayPreferredUntil <= currentMs
          && state.cooldownUntil <= currentMs
          && state.failures <= 0
        ) continue;
        targets.push({ kind, marketType, state });
      }
    }
    if (!targets.length) return;
    this.backgroundProbeRunning = true;
    try {
      await Promise.allSettled(targets.map(async ({ kind, marketType, state }) => {
        if (state.probing) return;
        state.probing = true;
        try {
          if (kind === "public") {
            await this.probePublicDirect(marketType, Math.max(500, this.publicHedgeDelayMs * 2));
          }
          else await this.probePrivateDirect(marketType);
          this.markDirectSuccess(kind, marketType);
        } catch {
          this.markDirectFailure(kind, marketType);
        } finally {
          state.probing = false;
        }
      }));
    } finally {
      this.backgroundProbeRunning = false;
    }
  }

  startBackgroundProbes({ initialDelayMs = 1_500 } = {}) {
    if (this.backgroundProbeTimer !== null || this.backgroundProbeInitialTimer !== null) return;
    const tick = () => void this.runBackgroundProbes();
    this.backgroundProbeInitialTimer = setTimeout(() => {
      this.backgroundProbeInitialTimer = null;
      tick();
    }, Math.max(0, Number(initialDelayMs) || 0));
    this.backgroundProbeInitialTimer.unref?.();
    this.backgroundProbeTimer = setInterval(tick, this.backgroundProbeIntervalMs);
    this.backgroundProbeTimer.unref?.();
  }

  close() {
    if (this.backgroundProbeInitialTimer !== null) {
      clearTimeout(this.backgroundProbeInitialTimer);
      this.backgroundProbeInitialTimer = null;
    }
    if (this.backgroundProbeTimer !== null) {
      clearInterval(this.backgroundProbeTimer);
      this.backgroundProbeTimer = null;
    }
  }

  async gatewayStreamEndpoint({ marketType, combined, streamClass }) {
    const params = { marketType, combined, streamClass };
    const connection = this.gatewayClient.marketStreamConnection
      ? await this.gatewayClient.marketStreamConnection(params)
      : { url: await this.gatewayClient.marketStreamEndpoint(params) };
    return Object.freeze({ ...connection, route: "gateway", marketType, streamClass });
  }

  async marketStreamEndpoint({ marketType: value, combined = false, streamClass: streamClassValue = "market" } = {}) {
    const marketType = normalizedMarketType(value);
    const streamClass = normalizedStreamClass(streamClassValue);
    const directEndpoint = this.config.publicWebSocket[websocketKey(marketType, combined, streamClass)]
      || this.config.publicWebSocket[websocketKey(marketType, combined)];
    const mode = this.config.routingMode || this.config.mode || "direct";
    if (mode === "direct" || !this.fallbackAvailable("public")) {
      return Object.freeze({ url: directEndpoint, route: "direct", marketType, streamClass });
    }
    if (mode === "gateway") {
      return this.gatewayStreamEndpoint({ marketType, combined, streamClass });
    }
    const state = this.state(routeKey("public", marketType));
    const currentMs = this.currentTimeMs();
    if (
      state.gatewayPreferredUntil > currentMs
      || state.cooldownUntil > currentMs
      || state.probing
    ) {
      return this.gatewayStreamEndpoint({ marketType, combined, streamClass });
    }
    if (state.healthyUntil > currentMs) {
      return Object.freeze({ url: directEndpoint, route: "direct", marketType, streamClass });
    }
    state.probing = true;
    try {
      const response = await fetchWithDeadline(
        (input, init) => this.directRequest("public", input, init),
        marketType === "futures"
          ? `${this.config.publicRest.futures}/fapi/v1/ping`
          : `${this.config.publicRest.spot}/api/v3/ping`,
        { method: "GET", cache: "no-store" },
        this.publicHedgeDelayMs,
      );
      discardBinanceResponse(response);
      if (Number(response?.status) !== 200) {
        throw new Error(`Binance direct stream probe failed with HTTP ${response?.status || 0}`);
      }
      this.markDirectSuccess("public", marketType);
      return Object.freeze({ url: directEndpoint, route: "direct", marketType, streamClass });
    } catch {
      this.markDirectSlow("public", marketType);
      return this.gatewayStreamEndpoint({ marketType, combined, streamClass });
    } finally {
      state.probing = false;
    }
  }

  reportMarketStreamOutcome({ marketType: value, route, outcome, connectedDurationMs = 0 } = {}) {
    if (route !== "direct" || (this.config.routingMode || this.config.mode) !== "auto") return;
    const marketType = normalizedMarketType(value);
    if (outcome === "connected") {
      this.markDirectSuccess("public", marketType);
      return;
    }
    if (outcome === "failed" && Number(connectedDurationMs || 0) < 30_000) {
      this.markDirectFailure("public", marketType);
    }
  }

  snapshot() {
    const currentMs = this.currentTimeMs();
    return Object.freeze(Object.fromEntries([...this.states].map(([key, state]) => [key, Object.freeze({
      failures: state.failures,
      cooldownRemainingMs: Math.max(0, state.cooldownUntil - currentMs),
      healthyRemainingMs: Math.max(0, state.healthyUntil - currentMs),
      gatewayPreferenceRemainingMs: Math.max(0, state.gatewayPreferredUntil - currentMs),
      probing: state.probing,
    })])));
  }
}

export { ACCOUNT_ORIGINS, ROUTE_BLOCKING_STATUSES };
