// [精简] 空实现，保留导出名。
const ALLOWED_BINANCE_ACCOUNT_ORIGINS = new Set([
  "https://api.binance.com",
  "https://fapi1.binance.com",
]);
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "user-agent", "x-mbx-apikey"]);
function parseRetryAfterMs() { return null; }

export async function performHttpsConnectRequest() { return {}; }

export class BinancePrivateProxyTransport {
  constructor() { return new Proxy(this, { get(t, k) { if (k in t) return t[k]; return () => ({}); } }); }
}

export { ALLOWED_BINANCE_ACCOUNT_ORIGINS, ALLOWED_REQUEST_HEADERS, parseRetryAfterMs };
