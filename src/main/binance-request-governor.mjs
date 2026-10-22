import fs from "node:fs";
import path from "node:path";
import { bufferBinanceResponse, discardBinanceResponse } from "./binance-response-body.mjs";

const WINDOW_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_BAN_RETRY_AFTER_MS = 5 * 60_000;
const BINANCE_HOST_PATTERN = /(^|\.)binance\.com$|^data-api\.binance\.vision$/i;
const MAX_DIAGNOSTIC_EVENTS = 128;

export const BINANCE_REQUEST_PRIORITIES = Object.freeze({
  accountInteractive: 120,
  account: 100,
  chart: 90,
  market: 70,
  alert: 50,
  metadata: 20,
});

// Internal marker used to avoid observing the same direct 418/429 twice: the
// router also sees the response so it can protect background probes, while
// the governor owns the foreground request's persisted cooldown and metrics.
export const BINANCE_REQUEST_GOVERNOR_MANAGED = Symbol("binanceRequestGovernorManaged");

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nowValue(now) {
  const value = typeof now === "function" ? now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value) || Date.now();
}

function requestUrl(input) {
  try {
    return new URL(typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || input));
  } catch {
    return null;
  }
}

export function isBinanceHttpUrl(input) {
  const url = requestUrl(input);
  return Boolean(url && /^https?:$/i.test(url.protocol) && BINANCE_HOST_PATTERN.test(url.hostname));
}

export function binanceRequestBucket(input) {
  const url = requestUrl(input);
  if (!url || !BINANCE_HOST_PATTERN.test(url.hostname)) return "other";
  return url.hostname.toLowerCase().startsWith("fapi.") || url.pathname.startsWith("/fapi/") || url.pathname.startsWith("/futures/")
    ? "futures"
    : "spot";
}

export function binanceRequestEndpointClass(input) {
  const url = requestUrl(input);
  const pathname = String(url?.pathname || "");
  if (pathname.endsWith("/exchangeInfo")) return "metadata";
  if (pathname.endsWith("/klines") || pathname.endsWith("/uiKlines")) return "candles";
  if (pathname.endsWith("/ticker/24hr")) return url?.searchParams?.has("symbol") ? "ticker" : "ticker-catalog";
  if (pathname.endsWith("/premiumIndex")) return "mark-price";
  if (pathname.endsWith("/openInterest") || pathname.endsWith("/openInterestHist")) return "open-interest";
  if (pathname.endsWith("/aggTrades")) return "aggregate-trades";
  if (pathname.endsWith("/depth")) return "depth";
  if (/\/(account|positionRisk|openOrders|openAlgoOrders|userTrades|income)$/.test(pathname)) return "account";
  if (pathname.endsWith("/wallet/balance")) return "wallet";
  if (pathname.endsWith("/ping") || pathname.endsWith("/time")) return "probe";
  return "other";
}

function depthWeight(limit, futures) {
  if (futures) {
    if (limit <= 50) return 2;
    if (limit <= 100) return 5;
    if (limit <= 500) return 10;
    return 20;
  }
  if (limit <= 100) return 5;
  if (limit <= 500) return 25;
  if (limit <= 1_000) return 50;
  return 250;
}

function futuresKlineWeight(limit) {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1_000) return 5;
  return 10;
}

// Conservative weights are used for admission before the route is known. Once
// the response arrives, only direct traffic remains charged to the local egress.
export function binanceRequestWeight(input, init = {}) {
  const url = requestUrl(input);
  if (!url || !BINANCE_HOST_PATTERN.test(url.hostname)) return 0;
  const pathname = url.pathname;
  const method = String(init?.method || "GET").toUpperCase();
  const hasSymbol = Boolean(url.searchParams.get("symbol"));
  const limit = positiveInteger(url.searchParams.get("limit"), 500);
  const futures = binanceRequestBucket(url) === "futures";

  if (pathname === "/sapi/v1/asset/wallet/balance") return 60;
  if (/\/fapi\/v\d+\/income$/.test(pathname)) return 30;
  if (/\/fapi\/v\d+\/(openOrders|openAlgoOrders)$/.test(pathname)) return hasSymbol ? 1 : 40;
  if (/\/fapi\/v\d+\/(account|positionRisk)$/.test(pathname)) return 5;
  if (/\/fapi\/v\d+\/userTrades$/.test(pathname)) return 5;
  if (/\/fapi\/v\d+\/aggTrades$/.test(pathname)) return 20;
  if (/\/fapi\/v\d+\/depth$/.test(pathname)) return depthWeight(limit, true);
  if (/\/api\/v3\/depth$/.test(pathname)) return depthWeight(limit, false);
  if (/\/fapi\/v\d+\/klines$/.test(pathname)) return futuresKlineWeight(limit);
  if (/\/api\/v3\/klines$/.test(pathname)) return 2;
  if (/\/fapi\/v\d+\/ticker\/24hr$/.test(pathname)) return hasSymbol ? 1 : 40;
  if (/\/api\/v3\/ticker\/24hr$/.test(pathname)) {
    if (hasSymbol) return 2;
    try {
      const symbols = JSON.parse(url.searchParams.get("symbols") || "null");
      if (Array.isArray(symbols) && symbols.length > 0) return symbols.length <= 20 ? 2 : symbols.length <= 100 ? 40 : 80;
    } catch {}
    return 80;
  }
  if (pathname === "/fapi/v1/exchangeInfo" || pathname === "/api/v3/exchangeInfo") return futures ? 1 : 20;
  if (method !== "GET" && pathname.includes("/listenKey")) return 1;
  return 1;
}

export function parseBinanceRetryAfterMs(response, currentMs = Date.now()) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - currentMs) : null;
}

function localRateLimitResponse(retryAfterMs, reason, source = "local-budget") {
  const safeRetryMs = Math.max(1_000, positiveInteger(retryAfterMs, DEFAULT_RETRY_AFTER_MS));
  return new Response(JSON.stringify({
    code: -1003,
    msg: reason === "upstream"
      ? "Binance shared cooldown is active."
      : "Binance local request-weight budget is exhausted.",
  }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, Math.ceil(safeRetryMs / 1_000))),
      "x-velune-binance-governor": reason,
      "x-velune-binance-route": "client",
      "x-velune-binance-egress": "client",
      "x-velune-rate-limit-source": source,
    },
  });
}

function boundedText(value, fallback = "unknown", max = 64) {
  const normalized = String(value || "").trim().toLowerCase();
  return (normalized || fallback).slice(0, max);
}

function responseRateLimitOrigin(response) {
  const status = Number(response?.status || 0);
  const route = boundedText(response?.headers?.get?.("x-velune-binance-route"), "direct");
  const egress = boundedText(
    response?.headers?.get?.("x-velune-binance-egress"),
    route === "direct" ? "local" : route,
  );
  const source = boundedText(response?.headers?.get?.("x-velune-rate-limit-source"), "");
  const governor = boundedText(response?.headers?.get?.("x-velune-binance-governor"), "");
  let origin = "none";
  if (governor === "budget" || source === "local-budget") origin = "local_budget";
  else if (source === "gateway-downstream") origin = "gateway_downstream";
  else if (source === "gateway-upstream") origin = "gateway_upstream";
  else if ((status === 418 || status === 429) && route.includes("gateway")) origin = "gateway_downstream";
  else if (status === 418 || status === 429 || source === "direct-binance") origin = "direct_binance";
  return { route, egress, origin };
}

function responseCopy(response) {
  return typeof response?.clone === "function" ? response.clone() : response;
}

function abortReason(signal) {
  return signal?.reason || new DOMException("The operation was aborted", "AbortError");
}

function requestTimeoutError(timeoutMs) {
  const error = new Error(`Binance network request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function runWithExecutionDeadline(networkFetch, input, init, timeoutMs, onResponse) {
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) throw abortReason(callerSignal);
  const durationMs = Number(timeoutMs ?? 45_000);
  const controller = new AbortController();
  const forwardAbort = callerSignal
    ? () => controller.abort(abortReason(callerSignal))
    : null;
  if (forwardAbort) callerSignal.addEventListener("abort", forwardAbort, { once: true });
  let timer = null;
  let rejectAbort = null;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(abortReason(controller.signal));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  if (Number.isFinite(durationMs) && durationMs > 0) {
    timer = setTimeout(() => controller.abort(requestTimeoutError(Math.floor(durationMs))), Math.floor(durationMs));
    timer.unref?.();
  }
  let response;
  const request = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    response = await networkFetch(input, { ...init, signal: controller.signal });
    // A transport that ignores abort may still return headers after the race.
    if (controller.signal.aborted) {
      discardBinanceResponse(response, controller.signal.reason);
      throw abortReason(controller.signal);
    }
    onResponse(response);
    return bufferBinanceResponse(response, { signal: controller.signal });
  });
  try {
    return await Promise.race([
      request,
      aborted,
    ]);
  } catch (error) {
    // Preserve HTTP rate-limit/status evidence even if its body is interrupted.
    if (response && error && typeof error === "object" && Object.isExtensible(error)) {
      error.binanceResponse = { status: response.status, headers: response.headers };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    if (forwardAbort) callerSignal.removeEventListener("abort", forwardAbort);
  }
}

export class BinanceRequestGovernor {
  constructor({
    statePath = "",
    now = Date.now,
    maxConcurrency = 4,
    safetyRatio = 0.6,
    limits = {},
    onDiagnostic = null,
  } = {}) {
    this.statePath = String(statePath || "");
    this.now = now;
    this.maxConcurrency = Math.max(1, positiveInteger(maxConcurrency, 4));
    this.safetyRatio = Math.min(0.9, Math.max(0.1, Number(safetyRatio) || 0.6));
    this.limits = {
      futures: positiveInteger(limits.futures, 2_400),
      spot: positiveInteger(limits.spot, 6_000),
    };
    this.entries = new Map([["futures", []], ["spot", []]]);
    this.observedUsedWeight = new Map();
    this.bucketCooldownUntil = new Map();
    this.queue = [];
    this.running = 0;
    this.sequence = 0;
    this.inflightPublicGets = new Map();
    this.metrics = {
      admitted: 0,
      coalesced: 0,
      blocked: 0,
      upstreamRateLimits: 0,
      localBudgetBlocks: 0,
      directRateLimits: 0,
      gatewayDownstreamRateLimits: 0,
      gatewayUpstreamRateLimits: 0,
    };
    this.diagnostics = [];
    this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
    this.loadState();
  }

  loadState() {
    if (!this.statePath) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      const currentMs = nowValue(this.now);
      const legacyGlobal = Number(state?.globalCooldownUntil);
      for (const bucket of ["futures", "spot"]) {
        const value = Number(state?.bucketCooldownUntil?.[bucket] ?? legacyGlobal);
        if (Number.isFinite(value) && value > currentMs) this.bucketCooldownUntil.set(bucket, value);
      }
    } catch {}
  }

  persistState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({
        version: 2,
        bucketCooldownUntil: Object.fromEntries(this.bucketCooldownUntil),
      }), "utf8");
    } catch {}
  }

  snapshot() {
    const currentMs = nowValue(this.now);
    return Object.freeze({
      ...this.metrics,
      running: this.running,
      queued: this.queue.length,
      globalCooldownRemainingMs: Math.max(0, ...[...this.bucketCooldownUntil.values()].map((value) => value - currentMs)),
      cooldowns: Object.freeze(Object.fromEntries(["futures", "spot"].map((bucket) => [
        bucket,
        Math.max(0, Number(this.bucketCooldownUntil.get(bucket) || 0) - currentMs),
      ]))),
      futuresWeight: this.usedWeight("futures", currentMs),
      spotWeight: this.usedWeight("spot", currentMs),
      observedWeightByEgress: Object.freeze(Object.fromEntries([...this.observedUsedWeight].flatMap(([key, record]) => (
        record.expiresAt > currentMs ? [[key, record.value]] : []
      )))),
      recentDiagnostics: Object.freeze(this.diagnostics.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  usedWeight(bucket, currentMs = nowValue(this.now)) {
    const entries = this.entries.get(bucket) || [];
    while (entries.length && entries[0].at <= currentMs - WINDOW_MS) entries.shift();
    const reserved = entries.reduce((total, entry) => total + entry.weight, 0);
    const observed = this.observedUsedWeight.get(`local:${bucket}`);
    const observedValue = observed?.expiresAt > currentMs ? observed.value : 0;
    return Math.max(reserved, observedValue);
  }

  budgetLimit(bucket) {
    return Math.max(1, Math.floor((this.limits[bucket] || this.limits.spot) * this.safetyRatio));
  }

  retryAfterForBudget(bucket, currentMs) {
    const entries = this.entries.get(bucket) || [];
    const candidates = [];
    if (entries[0]) candidates.push(entries[0].at + WINDOW_MS);
    const observed = this.observedUsedWeight.get(`local:${bucket}`);
    if (observed?.expiresAt > currentMs) candidates.push(observed.expiresAt);
    return Math.max(1_000, Math.min(...(candidates.length ? candidates : [currentMs + WINDOW_MS])) - currentMs);
  }

  reserve(bucket, weight, currentMs) {
    const used = this.usedWeight(bucket, currentMs);
    if (used + weight > this.budgetLimit(bucket)) return null;
    const reservation = { at: currentMs, weight };
    this.entries.get(bucket).push(reservation);
    return reservation;
  }

  releaseReservation(bucket, reservation) {
    const entries = this.entries.get(bucket) || [];
    const index = entries.indexOf(reservation);
    if (index >= 0) entries.splice(index, 1);
  }

  cooldownRemaining(bucket, currentMs) {
    return Math.max(0, Number(this.bucketCooldownUntil.get(bucket) || 0) - currentMs);
  }

  setUpstreamCooldown(bucket, until) {
    if (until <= Number(this.bucketCooldownUntil.get(bucket) || 0)) return;
    this.bucketCooldownUntil.set(bucket, until);
    this.persistState();
  }

  observeResponse(bucket, response, currentMs) {
    const provenance = responseRateLimitOrigin(response);
    const usedHeader = response?.headers?.get?.("x-mbx-used-weight-1m")
      || response?.headers?.get?.("x-sapi-used-ip-weight-1m")
      || response?.headers?.get?.("x-mbx-used-weight");
    const used = usedHeader == null || String(usedHeader).trim() === "" ? Number.NaN : Number(usedHeader);
    const gatewayRemainingHeader = response?.headers?.get?.("x-ratelimit-remaining");
    const gatewayRemaining = gatewayRemainingHeader == null || String(gatewayRemainingHeader).trim() === ""
      ? Number.NaN
      : Number(gatewayRemainingHeader);
    if (Number.isFinite(used) && used >= 0) {
      const serverDate = Date.parse(response?.headers?.get?.("date") || "");
      const measuredAt = Number.isFinite(serverDate) ? serverDate : currentMs;
      // Binance reports a fixed minute window. Do not retain its last sample
      // for another rolling minute after that window has reset. One second
      // covers HTTP Date precision; own reservations remain conservative.
      const expiresAt = currentMs + WINDOW_MS - (measuredAt % WINDOW_MS) + 1_000;
      const key = `${provenance.egress}:${bucket}`;
      const previous = this.observedUsedWeight.get(key);
      const windowId = Math.floor(measuredAt / WINDOW_MS);
      if (!previous || windowId >= previous.windowId) {
        this.observedUsedWeight.set(key, { at: currentMs, expiresAt,
          windowId, value: previous?.windowId === windowId ? Math.max(previous.value, used) : used });
      }
    }
    const status = Number(response?.status || 0);
    const upstreamStatus = Number(response?.headers?.get?.("x-velune-upstream-status") || 0);
    const rateLimited = status === 429
      || status === 418
      || provenance.origin === "gateway_downstream"
      || (provenance.origin === "gateway_upstream" && [418, 429].includes(upstreamStatus));
    if (rateLimited) {
      const retryAfterMs = parseBinanceRetryAfterMs(response, currentMs)
        ?? (status === 418 ? DEFAULT_BAN_RETRY_AFTER_MS : DEFAULT_RETRY_AFTER_MS);
      this.metrics.upstreamRateLimits += 1;
      if (provenance.origin === "direct_binance") {
        this.metrics.directRateLimits += 1;
        this.setUpstreamCooldown(bucket, currentMs + Math.max(1_000, retryAfterMs));
      } else if (provenance.origin === "gateway_downstream") {
        this.metrics.gatewayDownstreamRateLimits += 1;
      } else if (provenance.origin === "gateway_upstream") {
        this.metrics.gatewayUpstreamRateLimits += 1;
      }
    }
    return {
      ...provenance,
      usedWeight: Number.isFinite(used) && used >= 0 ? used : null,
      gatewayRemaining: Number.isFinite(gatewayRemaining) && gatewayRemaining >= 0 ? gatewayRemaining : null,
      cacheStatus: boundedText(response?.headers?.get?.("x-velune-cache"), "none"),
      limitScope: boundedText(response?.headers?.get?.("x-velune-rate-limit-scope"), "unknown"),
      upstreamStatus: [418, 429].includes(upstreamStatus) ? upstreamStatus : null,
      retryAfterMs: parseBinanceRetryAfterMs(response, currentMs),
    };
  }

  recordDiagnostic(value) {
    const entry = Object.freeze({ ...value });
    this.diagnostics.push(entry);
    while (this.diagnostics.length > MAX_DIAGNOSTIC_EVENTS) this.diagnostics.shift();
    if (this.onDiagnostic) {
      try { this.onDiagnostic(entry); } catch {}
    }
  }

  enqueue(run, priority, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const task = {
        run,
        priority: Number(priority) || 0,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
        abortQueued: null,
      };
      task.abortQueued = signal
        ? () => {
          const index = this.queue.indexOf(task);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", task.abortQueued);
          reject(abortReason(signal));
        }
        : null;
      if (task.abortQueued) signal.addEventListener("abort", task.abortQueued, { once: true });
      this.queue.push(task);
      this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this.pump();
    });
  }

  pump() {
    while (this.running < this.maxConcurrency && this.queue.length) {
      const task = this.queue.shift();
      if (task.abortQueued) task.signal.removeEventListener("abort", task.abortQueued);
      this.running += 1;
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  async fetch(networkFetch, input, init = {}, context = {}) {
    if (typeof networkFetch !== "function") throw new TypeError("networkFetch must be a function");
    if (init?.signal?.aborted) throw abortReason(init.signal);
    if (!isBinanceHttpUrl(input)) return networkFetch(input, init);
    const url = requestUrl(input);
    const bucket = binanceRequestBucket(url);
    const method = String(init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers || {});
    const isPublicGet = method === "GET" && !headers.has("x-mbx-apikey")
      && !url.searchParams.has("signature");
    const publicFallbackFetch = isPublicGet && typeof context.publicFallbackFetch === "function"
      ? context.publicFallbackFetch : null;
    const currentMs = nowValue(this.now);
    const cooldownMs = this.cooldownRemaining(bucket, currentMs);
    if (cooldownMs > 0 && !publicFallbackFetch) {
      this.metrics.blocked += 1;
      this.recordDiagnostic({
        at: currentMs,
        source: boundedText(context.source, "market"),
        bucket,
        endpointClass: binanceRequestEndpointClass(url),
        pathname: url.pathname,
        route: "client",
        egress: "client",
        origin: "direct_binance",
        status: 429,
        retryAfterMs: cooldownMs,
        weight: 0,
        running: this.running,
        queued: this.queue.length,
      });
      return localRateLimitResponse(cooldownMs, "upstream", "direct-binance");
    }

    const dedupeKey = isPublicGet ? `${method} ${url.href}` : "";
    const pending = dedupeKey ? this.inflightPublicGets.get(dedupeKey) : null;
    if (pending) {
      this.metrics.coalesced += 1;
      return this.joinPublicRequest(pending, dedupeKey, init?.signal);
    }

    const weight = Math.max(1, positiveInteger(context.weight, binanceRequestWeight(url, init)));
    let reservation = null;

    this.metrics.admitted += 1;
    const shared = dedupeKey ? { controller: new AbortController(), consumers: 0, settled: false, promise: null } : null;
    const networkInit = {
      ...init,
      [BINANCE_REQUEST_GOVERNOR_MANAGED]: true,
      ...(shared ? { signal: shared.controller.signal } : {}),
    };
    let networkStarted = false;
    const request = this.enqueue(async () => {
      const startedAt = nowValue(this.now);
      try {
        // Requests may wait behind another request which receives 418/429.
        // Recheck at admission; never let a queued request extend that ban.
        const queuedCooldownMs = this.cooldownRemaining(bucket, startedAt);
        // Reserve when work actually starts, after priority ordering. Queued
        // prefetches cannot spend the chart's capacity or age out before I/O.
        reservation = queuedCooldownMs > 0 ? null : this.reserve(bucket, weight, startedAt);
        const needsFallback = !reservation || queuedCooldownMs > 0;
        if (needsFallback && !publicFallbackFetch) {
          this.releaseReservation(bucket, reservation);
          const budgetBlocked = queuedCooldownMs <= 0;
          const retryAfterMs = queuedCooldownMs || this.retryAfterForBudget(bucket, startedAt);
          this.metrics.blocked += 1;
          if (budgetBlocked) this.metrics.localBudgetBlocks += 1;
          this.recordDiagnostic({ at: startedAt, source: boundedText(context.source, "market"), bucket,
            endpointClass: binanceRequestEndpointClass(url), pathname: url.pathname,
            route: "client", egress: "client", origin: budgetBlocked ? "local_budget" : "direct_binance",
            status: 429, retryAfterMs, weight, running: this.running, queued: this.queue.length });
          return localRateLimitResponse(retryAfterMs, budgetBlocked ? "budget" : "upstream",
            budgetBlocked ? "local-budget" : "direct-binance");
        }
        const transport = needsFallback ? publicFallbackFetch : networkFetch;
        if (needsFallback) this.releaseReservation(bucket, reservation);
        let observation;
        const response = await runWithExecutionDeadline((...args) => {
          networkStarted = true;
          return transport(...args);
        }, input, networkInit, context.timeoutMs, (headersResponse) => {
          observation = this.observeResponse(bucket, headersResponse, nowValue(this.now));
          if (observation.egress !== "local") this.releaseReservation(bucket, reservation);
        });
        const finishedAt = nowValue(this.now);
        this.recordDiagnostic({
          at: finishedAt,
          source: boundedText(context.source, "market"),
          bucket,
          endpointClass: binanceRequestEndpointClass(url),
          pathname: url.pathname,
          route: observation.route,
          egress: observation.egress,
          origin: observation.origin,
          status: Number(response?.status || 0),
          retryAfterMs: observation.retryAfterMs,
          usedWeight: observation.usedWeight,
          gatewayRemaining: Number.isFinite(observation.gatewayRemaining) ? observation.gatewayRemaining : null,
          cacheStatus: observation.cacheStatus,
          limitScope: observation.limitScope,
          weight,
          durationMs: Math.max(0, finishedAt - startedAt),
          running: this.running,
          queued: this.queue.length,
        });
        return response;
      } catch (error) {
        const finishedAt = nowValue(this.now);
        this.recordDiagnostic({
          at: finishedAt,
          source: boundedText(context.source, "market"),
          bucket,
          endpointClass: binanceRequestEndpointClass(url),
          pathname: url.pathname,
          route: "unknown",
          egress: "unknown",
          origin: "transport",
          status: 0,
          retryAfterMs: null,
          weight,
          durationMs: Math.max(0, finishedAt - startedAt),
          running: this.running,
          queued: this.queue.length,
        });
        throw error;
      }
    }, context.priority ?? BINANCE_REQUEST_PRIORITIES.market, networkInit?.signal);
    const tracked = request.catch((error) => {
      if (!networkStarted) this.releaseReservation(bucket, reservation);
      throw error;
    }).finally(() => {
      if (shared) shared.settled = true;
      if (shared && this.inflightPublicGets.get(dedupeKey) === shared) this.inflightPublicGets.delete(dedupeKey);
    });
    if (shared) {
      shared.promise = tracked;
      this.inflightPublicGets.set(dedupeKey, shared);
      return this.joinPublicRequest(shared, dedupeKey, init?.signal);
    }
    return tracked;
  }

  async joinPublicRequest(shared, key, signal) {
    shared.consumers += 1;
    try {
      const response = await awaitWithSignal(shared.promise, signal);
      signal?.throwIfAborted();
      return responseCopy(response);
    } finally {
      shared.consumers -= 1;
      if (!shared.settled && shared.consumers === 0) {
        if (this.inflightPublicGets.get(key) === shared) this.inflightPublicGets.delete(key);
        shared.controller.abort(abortReason(signal));
      }
    }
  }
}
