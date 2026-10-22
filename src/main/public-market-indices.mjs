const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FNG_URL = "https://api.alternative.me/fng/?limit=31";
const BINANCE_DOCS = "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio";
export const PUBLIC_INDEX_CATALOG = Object.freeze([
  { id: "alternative:fng", name: "恐惧与贪婪指数", code: "FGI", source: "Alternative.me", sourceUrl: "https://alternative.me/crypto/fear-and-greed-index/", intervalMs: DAY, description: "0–100，数值越高表示市场情绪越贪婪；每日更新。" },
  ...["BTC", "ETH"].flatMap(symbol => [
    { kind: "accounts", label: "多空人数比", route: "globalLongShortAccountRatio", description: "持有净多仓的账户数 ÷ 持有净空仓的账户数。" },
    { kind: "top-accounts", label: "大户多空人数比", route: "topLongShortAccountRatio", description: "保证金余额前 20% 用户中，净多仓账户数 ÷ 净空仓账户数。" },
    { kind: "top-positions", label: "大户多空持仓比", route: "topLongShortPositionRatio", description: "保证金余额前 20% 用户中，多仓持仓量 ÷ 空仓持仓量。" },
  ].map(item => ({ id: `binance:${symbol.toLowerCase()}:${item.kind}`, name: `${symbol} ${item.label}`, code: `${symbol}/USDT`, source: "Binance", sourceUrl: BINANCE_DOCS, intervalMs: HOUR, symbol: `${symbol}USDT`, route: item.route, description: `${item.description}按小时采样；24H 涨幅为比值自身相对 24 小时前的变化。` }))),
]);

function finite(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeIndexSeries(definition, payload, now = Date.now()) {
  const fearGreed = definition.id === "alternative:fng";
  const rows = fearGreed ? payload?.data : payload;
  if (!Array.isArray(rows) || (fearGreed && payload?.metadata?.error)) throw Error("Invalid index response");
  const byTime = new Map();
  for (const row of rows) {
    if (!row || (row.symbol && row.symbol !== definition.symbol)) continue;
    const value = finite(fearGreed ? row.value : row.longShortRatio);
    const rawTime = finite(row.timestamp);
    const time = rawTime === null ? NaN : rawTime * (fearGreed ? 1000 : 1);
    if (value === null || value < 0 || (fearGreed && (value > 100 || !Number.isInteger(value))) || !Number.isSafeInteger(time) || time <= 0 || time > now + 60_000) continue;
    byTime.set(time, { time, value });
  }
  const series = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-200);
  if (!series.length) throw Error("Empty index response");
  return series;
}

function quote(definition, series, now, failed = false) {
  const latest = series.at(-1);
  // Compare timestamps, not array offsets: missing samples must not become a false 24H move.
  const previous = latest && series.findLast(point => point.time <= latest.time - DAY);
  const baseline = previous && latest.time - DAY - previous.time <= definition.intervalMs / 2 ? previous.value : null;
  const changePercent = latest && baseline !== null && baseline > 0 ? (latest.value / baseline - 1) * 100 : null;
  return {
    id: definition.id, name: definition.name, code: definition.code,
    source: definition.source, sourceUrl: definition.sourceUrl, description: definition.description,
    intervalMs: definition.intervalMs, value: latest?.value ?? null,
    changePercent: Number.isFinite(changePercent) ? changePercent : null,
    updatedAt: latest?.time ?? null, series,
    status: !latest ? "error" : failed || now - latest.time > (definition.intervalMs === DAY ? 36 * HOUR : 3 * HOUR) ? "stale" : "ready",
  };
}

async function readSmallJson(response) {
  if (!response.ok) throw Error("Index source unavailable");
  const maxBytes = 256 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes) throw Error("Index response too large");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw Error("Index response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Fixed public sources only; no keys, trading actions or renderer-supplied URLs. */
export class PublicMarketIndicesService {
  constructor({ fetch = globalThis.fetch, binanceRequest, now = Date.now } = {}) {
    this.fetch = fetch;
    this.binanceRequest = binanceRequest;
    this.now = now;
    this.cache = new Map();
    this.pending = null;
  }

  async load(definition) {
    const cached = this.cache.get(definition.id);
    if (cached?.expiresAt > this.now()) return quote(definition, cached.series, this.now(), cached.failed);
    try {
      const fearGreed = definition.id === "alternative:fng";
      let payload;
      let stale = false;
      if (fearGreed) {
        const response = await this.fetch(FNG_URL, { method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(12_000) });
        payload = await readSmallJson(response);
      } else {
        const response = await this.binanceRequest({ marketType: "futures", path: `/futures/data/${definition.route}`, parameters: { symbol: definition.symbol, period: "1h", limit: 169 } }, { signal: AbortSignal.timeout(15_000) });
        if (!response?.ok) throw Error("Binance index unavailable");
        payload = response.data;
        stale = Boolean(response.stale);
      }
      const series = normalizeIndexSeries(definition, payload, this.now());
      this.cache.set(definition.id, { series, failed: stale, expiresAt: this.now() + (stale ? 60_000 : fearGreed ? 10 * 60_000 : 5 * 60_000) });
      return quote(definition, series, this.now(), stale);
    } catch {
      const series = cached?.series || [];
      this.cache.set(definition.id, { series, failed: true, expiresAt: this.now() + 30_000 });
      return quote(definition, series, this.now(), true);
    }
  }

  async snapshot() {
    if (!this.pending) {
      this.pending = (async () => {
        const indices = [];
        // Limit concurrent public requests so the index list does not crowd out the chart.
        for (let offset = 0; offset < PUBLIC_INDEX_CATALOG.length; offset += 3) {
          indices.push(...await Promise.all(PUBLIC_INDEX_CATALOG.slice(offset, offset + 3).map(item => this.load(item))));
        }
        return { indices, fetchedAt: this.now() };
      })().finally(() => { this.pending = null; });
    }
    return structuredClone(await this.pending);
  }
}
