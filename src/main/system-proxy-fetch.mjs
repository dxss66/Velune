const RECOVERABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "NETWORK_ERROR",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT", "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED", "ERR_NAME_NOT_RESOLVED", "ERR_ADDRESS_UNREACHABLE",
  "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_SOCKS_CONNECTION_FAILED", "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE",
  "ERR_NO_SUPPORTED_PROXIES", "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
  "ERR_HTTP2_PROTOCOL_ERROR", "ERR_SSL_PROTOCOL_ERROR",
]);

export function networkErrorCode(error) {
  const visited = new Set();
  for (let current = error; current && !visited.has(current) && visited.size < 8; current = current.cause) {
    visited.add(current);
    const chromiumCode = String(current.message || "").match(/\bnet::(ERR_[A-Z0-9_]+)/)?.[1];
    if (chromiumCode) return chromiumCode;
    if (/^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|NETWORK_ERROR)$/.test(String(current.code || ""))) return current.code;
  }
  return error?.message === "fetch failed" ? "NETWORK_ERROR" : "";
}

export function isRecoverableNetworkError(error) {
  return RECOVERABLE_CODES.has(networkErrorCode(error));
}

export function isReadOnlyRequest(input, init = {}) {
  const method = String(init.method || input?.method || "GET").toUpperCase();
  return (method === "GET" || method === "HEAD") && init.body == null && input?.body == null;
}

export function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Proxy configuration refresh timed out")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// A separate session keeps account recovery from closing model/market streams.
// Chromium owns system proxy/PAC authentication and TLS verification on every OS.
export function createSystemProxyFetch({
  getSession,
  onDiagnostic = () => {},
  now = Date.now,
  refreshCooldownMs = 5_000,
  configurationTimeoutMs = 3_000,
} = {}) {
  if (typeof getSession !== "function") throw new TypeError("getSession is required");
  let sessionPromise = null;
  let refreshPromise = null;
  let nextRefreshAt = 0;

  function getReadySession() {
    if (!sessionPromise) {
      sessionPromise = Promise.resolve().then(getSession).then(async (ses) => {
        await bounded(ses.setProxy({ mode: "system" }), configurationTimeoutMs);
        return ses;
      }).catch((error) => { sessionPromise = null; throw error; });
    }
    return sessionPromise;
  }

  function diagnostic(input, init, error, attempt) {
    try {
      onDiagnostic({
        event: "service-network-failure",
        origin: new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin,
        method: String(init.method || input?.method || "GET").toUpperCase(),
        code: networkErrorCode(error) || "NETWORK_ERROR",
        attempt,
      });
    } catch { /* Diagnostics must not change request behavior or expose raw errors. */ }
  }

  function refresh(ses) {
    if (refreshPromise) return refreshPromise;
    if (now() < nextRefreshAt) return Promise.resolve(false);
    nextRefreshAt = now() + refreshCooldownMs;
    refreshPromise = bounded(
      Promise.resolve().then(() => ses.forceReloadProxyConfig()),
      configurationTimeoutMs,
    ).then(() => true, () => false).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  return async function systemProxyFetch(input, init = {}) {
    const signal = init.signal || input?.signal;
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const ses = await withAbort(getReadySession(), signal);
    try {
      return await ses.fetch(input, init);
    } catch (error) {
      diagnostic(input, init, error, 1);
      if (signal?.aborted || !isRecoverableNetworkError(error)) throw error;
      // Refresh future requests too, but never replay a possibly accepted write.
      const refreshed = await withAbort(refresh(ses), signal);
      if (!refreshed || !isReadOnlyRequest(input, init)) throw error;
      if (signal?.aborted) throw signal.reason || error;
      try {
        return await ses.fetch(input, init);
      } catch (retryError) {
        diagnostic(input, init, retryError, 2);
        throw retryError;
      }
    }
  };
}
