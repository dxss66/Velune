const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 15_000;
const MARKET_CACHE_TTL_MS = 10 * 60_000;
const MAX_COUNT = 12000;
const MAX_MARKETS = 20000;
const PROVIDERS = new Set(["gate", "bybit", "okx", "yahoo", "eastmoney", "fred"]);
const MARKET_PROVIDERS = new Set(["gate", "bybit", "okx", "eastmoney", "yahoo"]);

const cleanSymbol = value => String(value || "").trim().toUpperCase();
let runtimeFetch = (url, init) => globalThis.fetch(url, init);
const finite = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function intervalInfo(interval) {
  const raw = String(interval || "60").trim().toUpperCase();
  if (raw === "1D" || raw === "D" || raw === "1DAY") return { minutes: 1440, kind: "day" };
  if (raw === "1W" || raw === "W" || raw === "1WEEK") return { minutes: 10080, kind: "week" };
  if (raw === "1M" || raw === "M" || raw === "1MONTH") return { minutes: 43200, kind: "month" };
  const numeric = Number(raw.replace(/[^0-9]/g, ""));
  if (Number.isFinite(numeric) && numeric > 0) return { minutes: numeric, kind: "minute" };
  return { minutes: 60, kind: "minute" };
}

function aggregate(candles, targetMinutes) {
  const bucket = targetMinutes * 60;
  const out = [];
  for (const candle of candles) {
    const start = Math.floor(candle.time / bucket) * bucket;
    const last = out.at(-1);
    if (!last || last.time !== start) {
      out.push({ ...candle, time: start });
    } else {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume += candle.volume;
    }
  }
  return out;
}

function normalizeCandles(list, limit, targetMinutes, sourceMinutes) {
  const rows = list
    .map(item => ({
      time: Math.floor(Number(item.time)),
      open: finite(item.open),
      high: finite(item.high),
      low: finite(item.low),
      close: finite(item.close),
      volume: Math.max(0, finite(item.volume) ?? 0),
    }))
    .filter(item => Number.isSafeInteger(item.time) && item.time > 0
      && item.open !== null && item.open > 0
      && item.high !== null && item.high > 0
      && item.low !== null && item.low > 0
      && item.close !== null && item.close > 0)
    .sort((a, b) => a.time - b.time);
  const merged = sourceMinutes && targetMinutes > sourceMinutes
    ? aggregate(rows, targetMinutes)
    : rows;
  return merged.slice(-limit);
}

async function requestText(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await runtimeFetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
          accept: "application/json,text/csv,text/plain,*/*",
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error("request failed");
}

async function requestJson(url, options = {}) {
  return JSON.parse(await requestText(url, options));
}

async function gateCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.minutes;
  const source = target === 3 ? 1 : target === 120 || target === 240 ? 60 : target;
  const map = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d", 10080: "7d" };
  const pair = symbol.replace(/[-/]/g, "_");
  const rows = [];
  let to = Number(endTime) > 0 ? Math.floor(Number(endTime) / 1000) : null;
  for (let page = 0; page < 10 && rows.length < count; page += 1) {
    const limit = Math.min(1000, count - rows.length);
    const toParam = to ? `&to=${to}` : "";
    const payload = await requestJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${map[source] || "1h"}&limit=${limit}${toParam}`);
    const list = (Array.isArray(payload) ? payload : []).map(row => ({
      time: finite(row[0]),
      close: finite(row[2]),
      high: finite(row[3]),
      low: finite(row[4]),
      open: finite(row[5]),
      volume: finite(row[6]) ?? finite(row[1]) ?? 0,
    }));
    if (!list.length) break;
    rows.push(...list);
    const oldest = Math.min(...list.map(row => row.time).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || list.length < limit) break;
    to = oldest - 1;
  }
  return normalizeCandles(rows, count, target, source);
}

async function bybitCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.minutes;
  const map = { 1: "1", 3: "3", 5: "5", 15: "15", 30: "30", 60: "60", 120: "120", 240: "240", 1440: "D", 10080: "W" };
  const rows = [];
  let end = Number(endTime) > 0 ? Math.floor(Number(endTime)) : null;
  for (let page = 0; page < 10 && rows.length < count; page += 1) {
    const limit = Math.min(1000, count - rows.length);
    const endParam = end ? `&end=${end}` : "";
    const payload = await requestJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=${map[target] || "60"}&limit=${limit}${endParam}`);
    const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
    if (!list.length) break;
    rows.push(...list.map(row => ({
      time: finite(row[0]) === null ? null : Number(row[0]) / 1000,
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      volume: finite(row[5]) ?? 0,
    })));
    const oldest = Math.min(...list.map(row => Number(row[0])).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || list.length < limit) break;
    end = oldest - 1;
  }
  return normalizeCandles(rows, count, target, target);
}

async function okxCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.minutes;
  const map = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1H", 120: "2H", 240: "4H", 1440: "1D", 10080: "1W" };
  const rows = [];
  let after = Number(endTime) > 0 ? Math.floor(Number(endTime)) : null;
  for (let page = 0; page < 40 && rows.length < count; page += 1) {
    const limit = Math.min(100, count - rows.length);
    const url = after
      ? `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${map[target] || "1H"}&after=${after}&limit=${limit}`
      : `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${map[target] || "1H"}&limit=${Math.min(300, limit)}`;
    const payload = await requestJson(url);
    const list = Array.isArray(payload?.data) ? payload.data : [];
    if (!list.length) break;
    rows.push(...list.map(row => ({
      time: finite(row[0]) === null ? null : Number(row[0]) / 1000,
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      volume: finite(row[5]) ?? 0,
    })));
    const oldest = Number(list.at(-1)?.[0]);
    if (!after) {
      if (count <= 300) break;
      after = Number.isFinite(oldest) ? oldest : null;
    } else {
      after = Number.isFinite(oldest) ? oldest : null;
    }
    if (!after) break;
  }
  return normalizeCandles(rows, count, target, target);
}

function yahooRange(targetMinutes) {
  if (targetMinutes === 1) return "7d";
  if (targetMinutes <= 30) return "1mo";
  if (targetMinutes === 60) return "3mo";
  if (targetMinutes <= 240) return "6mo";
  if (targetMinutes === 1440) return "5y";
  return "10y";
}

async function sinaForexCandles(symbol, count, endTime) {
  const pair = symbol.replace(/=X$/i, "").replace(/[^A-Z]/gi, "").toLowerCase();
  const text = await requestText(`https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_=/NewForexService.getDayKLine?symbol=fx_s${pair}`);
  const match = /var\s+_\s*=\s*\(([\s\S]*)\)\s*;?/.exec(text);
  if (!match) throw new Error("Sina forex history unavailable");
  const rows = match[1].trim().replace(/^"|"$/g, "").split("|").flatMap(line => {
    const parts = line.split(",");
    if (parts.length < 5) return [];
    const time = Math.floor(Date.parse(`${parts[0].trim()}T00:00:00+08:00`) / 1000);
    const open = finite(parts[1]);
    const low = finite(parts[2]);
    const high = finite(parts[3]);
    const close = finite(parts[4]);
    if (!Number.isSafeInteger(time) || time <= 0 || open === null || low === null || high === null || close === null) return [];
    return [{ time, open, high, low, close, volume: 0 }];
  });
  const cutoff = Number(endTime) > 0 ? Number(endTime) / 1000 : Infinity;
  return normalizeCandles(rows.filter(row => row.time <= cutoff), count, 1440, 1440);
}

async function yahooCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.kind === "month" ? 43200 : info.minutes;
  const source = target === 3 ? 1 : target === 120 || target === 240 ? 60 : target;
  const map = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "60m", 1440: "1d", 10080: "1wk", 43200: "1mo" };
  if (target >= 1440 && /=[Xx]$/.test(symbol)) {
    try {
      return await sinaForexCandles(symbol, count, endTime);
    } catch {}
  }
  const useWindow = target >= 1440;
  const window = useWindow
    ? `period1=0&period2=${Number(endTime) > 0 ? Math.floor(Number(endTime) / 1000) : Math.floor(Date.now() / 1000)}`
    : `range=${yahooRange(source)}`;
  let payload = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      payload = await requestJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${map[source] || "1d"}&${window}`);
      if (payload?.chart?.result?.length) break;
    } catch {}
  }
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo data unavailable");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const rows = timestamps.map((time, index) => ({
    time,
    open: finite(quote.open?.[index]),
    high: finite(quote.high?.[index]),
    low: finite(quote.low?.[index]),
    close: finite(quote.close?.[index]),
    volume: finite(quote.volume?.[index]) ?? 0,
  }));
  return normalizeCandles(rows, count, target, source);
}

function eastmoneySecId(symbol) {
  const [code, exchange = ""] = symbol.split(".");
  const upper = exchange.toUpperCase();
  const prefix = upper === "SH" ? "1" : upper === "SZ" || upper === "BJ" ? "0" : upper === "HK" ? "116" : "1";
  return `${prefix}.${code}`;
}

function eastmoneyTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return Math.floor(Date.parse(`${text}T00:00:00+08:00`) / 1000);
  }
  const normalized = text.replace(" ", "T");
  const withSeconds = /:\d{2}$/.test(normalized) ? normalized : `${normalized}:00`;
  return Math.floor(Date.parse(`${withSeconds}+08:00`) / 1000);
}

async function sinaCnCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.kind === "month" ? 43200 : info.minutes;
  const scale = target >= 43200 ? 7200 : target >= 10080 ? 1200 : target >= 1440 ? 240 : target <= 1 ? 5 : target;
  const [code, suffix = "SZ"] = symbol.split(".");
  const prefix = suffix.toUpperCase() === "SH" ? "sh" : suffix.toUpperCase() === "BJ" ? "bj" : "sz";
  const payload = await requestJson(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${prefix}${code}&scale=${scale}&ma=no&datalen=10000`, {
    headers: { referer: "https://finance.sina.com.cn" },
  });
  const list = Array.isArray(payload) ? payload : [];
  const cutoff = Number(endTime) > 0 ? Number(endTime) / 1000 : Infinity;
  const rows = list.flatMap(item => {
    const time = eastmoneyTime(item?.day);
    const open = finite(item?.open);
    const high = finite(item?.high);
    const low = finite(item?.low);
    const close = finite(item?.close);
    if (!Number.isSafeInteger(time) || time <= 0 || time > cutoff || open === null || high === null || low === null || close === null) return [];
    return [{ time, open, high, low, close, volume: finite(item?.volume) ?? 0 }];
  });
  return normalizeCandles(rows, count, target, target);
}

async function eastmoneyCandles(symbol, interval, count, endTime) {
  const info = intervalInfo(interval);
  const target = info.kind === "day" ? 1440 : info.kind === "week" ? 10080 : info.kind === "month" ? 43200 : info.minutes;
  const source = target === 3 ? 1 : target === 120 || target === 240 ? 60 : target;
  const map = { 1: 1, 5: 5, 15: 15, 30: 30, 60: 60, 1440: 101, 10080: 102, 43200: 103 };
  const secid = eastmoneySecId(symbol);
  const end = Number(endTime) > 0
    ? new Date(Number(endTime) + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "")
    : "20500101";
  try {
    const payload = await requestJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${map[source] || 101}&fqt=1&beg=0&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`);
    const list = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
    if (!list.length) throw new Error("empty kline response");
    const rows = list.map(line => {
      const parts = String(line).split(",");
      return {
        time: eastmoneyTime(parts[0]),
        open: finite(parts[1]),
        close: finite(parts[2]),
        high: finite(parts[3]),
        low: finite(parts[4]),
        volume: finite(parts[5]) ?? 0,
      };
    });
    return normalizeCandles(rows, count, target, source);
  } catch (error) {
    if (/\.HK$/i.test(symbol)) {
      const yahooSymbol = `${symbol.slice(0, -3).replace(/^0+/, "").padStart(4, "0")}.HK`;
      return yahooCandles(yahooSymbol, interval, count, endTime);
    }
    if (/\.(SH|SZ|BJ)$/i.test(symbol)) {
      return sinaCnCandles(symbol, interval, count, endTime);
    }
    throw error;
  }
}

async function fredCandles(seriesId, count, endTime) {
  const csv = await requestText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`);
  const lines = csv.split(/\r?\n/).slice(1);
  const cutoff = Number(endTime) > 0 ? Number(endTime) / 1000 : Infinity;
  const rows = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    if (!date || raw === undefined || raw.trim() === "" || raw.trim() === ".") continue;
    const value = finite(raw);
    if (value === null) continue;
    const time = Math.floor(Date.parse(`${date.trim()}T00:00:00Z`) / 1000);
    if (!Number.isSafeInteger(time) || time <= 0 || time > cutoff) continue;
    rows.push({ time, open: value, high: value, low: value, close: value, volume: 0 });
  }
  return normalizeCandles(rows, count, 1440, 1440);
}

function marketRecord(provider, symbol, base, quote, exchange) {
  const cleanBase = String(base || "").trim().toUpperCase();
  const cleanQuote = String(quote || "").trim().toUpperCase();
  const display = cleanBase && cleanQuote ? `${cleanBase}/${cleanQuote}` : cleanBase || symbol;
  return {
    id: `${provider.toUpperCase()}:${symbol}`,
    provider,
    symbol,
    baseAsset: cleanBase || display,
    quoteAsset: cleanQuote,
    displaySymbol: display,
    description: `${display} ${exchange} 现货`,
    venue: exchange,
    exchange,
    country: "GLOBAL",
    source: provider,
    assetClass: "crypto",
    type: "spot",
    tag: "现货",
    currency: cleanQuote,
    marketType: "global",
    markPrice: 0,
    changePercent: 0,
    volume24h: 0,
    quoteAvailable: false,
  };
}

async function gateMarkets() {
  const payload = await requestJson("https://api.gateio.ws/api/v4/spot/currency_pairs");
  const list = Array.isArray(payload) ? payload : [];
  return list
    .filter(item => item && item.trade_status === "tradable" && item.id && item.base && item.quote)
    .map(item => marketRecord("gate", String(item.id).trim().toUpperCase(), item.base, item.quote, "Gate"));
}

async function bybitMarkets() {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const payload = await requestJson(`https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000${suffix}`);
    const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
    rows.push(...list);
    cursor = String(payload?.result?.nextPageCursor || "").trim();
    if (!cursor || !list.length) break;
  }
  return rows
    .filter(item => item && item.status === "Trading" && item.symbol && item.baseCoin && item.quoteCoin)
    .map(item => marketRecord("bybit", String(item.symbol).trim().toUpperCase(), item.baseCoin, item.quoteCoin, "Bybit"));
}

async function okxMarkets() {
  const payload = await requestJson("https://www.okx.com/api/v5/public/instruments?instType=SPOT");
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list
    .filter(item => item && item.state === "live" && item.instId && item.baseCcy && item.quoteCcy)
    .map(item => marketRecord("okx", String(item.instId).trim().toUpperCase(), item.baseCcy, item.quoteCcy, "OKX"));
}

function equityRecord(options) {
  const display = options.displaySymbol || options.symbol;
  return {
    id: options.id,
    provider: options.provider,
    symbol: options.symbol,
    baseAsset: display,
    quoteAsset: "",
    displaySymbol: display,
    description: options.description || options.name || options.symbol,
    venue: options.exchange,
    exchange: options.exchange,
    country: options.country,
    source: options.provider,
    assetClass: options.assetClass,
    type: options.type,
    tag: options.tag,
    currency: options.currency || "",
    marketType: "global",
    markPrice: Number(options.markPrice) > 0 ? Number(options.markPrice) : 0,
    changePercent: Number.isFinite(Number(options.changePercent)) ? Number(options.changePercent) : 0,
    volume24h: Number(options.volume24h) || 0,
    quoteAvailable: Number(options.markPrice) > 0,
  };
}

async function sinaFetchNode(node, page) {
  return requestJson(`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=${encodeURIComponent(node)}`);
}

async function sinaMarkets(node, kind) {
  const countText = await requestText(`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=${encodeURIComponent(node)}`);
  const total = Math.min(Number(String(countText).replace(/[^0-9]/g, "")) || 0, 7000);
  const rows = [];
  const lastPage = Math.ceil(total / 100);
  let nextPage = 1;
  const worker = async () => {
    while (nextPage <= lastPage) {
      const page = nextPage;
      nextPage += 1;
      try {
        const list = await sinaFetchNode(node, page);
        if (Array.isArray(list)) rows.push(...list);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, lastPage)) }, worker));
  return rows.flatMap(row => {
    const raw = String(row?.symbol || "").trim().toLowerCase();
    const code = String(row?.code || "").trim();
    const name = String(row?.name || "").trim();
    if (!raw || !code || !name) return [];
    const exchange = raw.startsWith("sh") ? "SSE" : raw.startsWith("bj") ? "BSE" : "SZSE";
    const symbol = `${code}.${exchange === "SSE" ? "SH" : exchange === "BSE" ? "BJ" : "SZ"}`;
    if (kind === "etf") {
      return [equityRecord({
        id: `EASTMONEY:${symbol}`,
        provider: "eastmoney",
        symbol,
        displaySymbol: `${name} ${code}`,
        description: name,
        name,
        country: "CN",
        exchange,
        currency: "CNY",
        tag: "ETF",
        assetClass: "etf",
        type: "etf",
        markPrice: Number(row.trade),
        changePercent: Number(row.changepercent),
      })];
    }
    if (kind === "index") {
      return [equityRecord({
        id: `EASTMONEY:${symbol}`,
        provider: "eastmoney",
        symbol,
        displaySymbol: name,
        description: `${name} ${code}`,
        name,
        country: "CN",
        exchange,
        currency: "CNY",
        tag: "指数",
        assetClass: "index",
        type: "index",
        markPrice: Number(row.trade),
        changePercent: Number(row.changepercent),
      })];
    }
    return [equityRecord({
      id: `EASTMONEY:${symbol}`,
      provider: "eastmoney",
      symbol,
      displaySymbol: `${name} ${code}`,
      description: name,
      name,
      country: "CN",
      exchange,
      currency: "CNY",
      tag: "A股",
      assetClass: "a-share",
      type: "stock",
      markPrice: Number(row.trade),
      changePercent: Number(row.changepercent),
    })];
  });
}

async function eastmoneyHkMarkets() {
  const first = await requestJson("https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_INFO_SECURITYINFO&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,SECURITY_TYPE&pageNumber=1&pageSize=100&sortColumns=SECURITY_CODE&sortTypes=1&source=SECURITIES&client=PC");
  const totalPages = Math.min(Number(first?.result?.pages) || 1, 40);
  const rows = Array.isArray(first?.result?.data) ? [...first.result.data] : [];
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= totalPages) {
      const page = nextPage;
      nextPage += 1;
      try {
        const payload = await requestJson(`https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_INFO_SECURITYINFO&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,SECURITY_TYPE&pageNumber=${page}&pageSize=100&sortColumns=SECURITY_CODE&sortTypes=1&source=SECURITIES&client=PC`);
        if (Array.isArray(payload?.result?.data)) rows.push(...payload.result.data);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(0, totalPages - 1)) }, worker));
  return rows.flatMap(row => {
    const symbol = String(row?.SECUCODE || "").trim().toUpperCase();
    const code = String(row?.SECURITY_CODE || "").trim();
    const name = String(row?.SECURITY_NAME_ABBR || "").trim();
    if (!symbol || !code || !name) return [];
    return [equityRecord({
      id: `EASTMONEY:${symbol}`,
      provider: "eastmoney",
      symbol,
      displaySymbol: `${name} ${code}`,
      description: name,
      name,
      country: "HK",
      exchange: "HKEX",
      currency: "HKD",
      tag: "港股",
      assetClass: "stock",
      type: "stock",
    })];
  });
}

async function eastmoneyMarkets() {
  const [aShares, etfs, indices, hongKong] = await Promise.allSettled([
    sinaMarkets("hs_a", "a"),
    sinaMarkets("etf_hq_fund", "etf"),
    sinaMarkets("hs_s", "index"),
    eastmoneyHkMarkets(),
  ]).then(results => results.map(task => task.status === "fulfilled" ? task.value : []));
  return [
    ...aShares,
    ...etfs,
    ...indices,
    ...hongKong,
  ];
}

function pipeRows(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split("|");
  return lines.slice(1)
    .filter(line => !line.startsWith("File Creation"))
    .map(line => Object.fromEntries(headers.map((header, index) => [header, (line.split("|")[index] || "").trim()])));
}

async function secUsMarkets() {
  const payload = await requestJson("https://www.sec.gov/files/company_tickers_exchange.json", {
    headers: { "user-agent": "Velune/1.0 market-browser contact@velune.app" },
  });
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const tickerIndex = fields.indexOf("ticker");
  const nameIndex = fields.indexOf("name");
  const exchangeIndex = fields.indexOf("exchange");
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (tickerIndex < 0 || nameIndex < 0) return [];
  const exchangeMap = {
    Nasdaq: "NASDAQ",
    NYSE: "NYSE",
    OTC: "OTC",
    CBOE: "CBOE",
    TXSE: "TXSE",
    "NYSE American": "AMEX",
    "NYSE Arca": "NYSEArca",
  };
  return rows.flatMap(row => {
    const symbol = String(row?.[tickerIndex] || "").trim().toUpperCase();
    const name = String(row?.[nameIndex] || "").trim();
    if (!symbol || !name || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return [];
    return [equityRecord({
      id: `YAHOO:${symbol}`,
      provider: "yahoo",
      symbol,
      displaySymbol: symbol,
      description: `${name} ${symbol}`,
      name,
      country: "US",
      exchange: exchangeMap[String(row?.[exchangeIndex] || "").trim()] || "US",
      currency: "USD",
      tag: "美股",
      assetClass: "stock",
      type: "stock",
    })];
  });
}

async function nasdaqTraderMarkets() {
  const [nasdaqText, otherText] = await Promise.all([
    requestText("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"),
    requestText("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"),
  ]);
  if (!nasdaqText.startsWith("Symbol|") || !otherText.startsWith("ACT Symbol|")) {
    throw new Error("unexpected symbol directory response");
  }
  const rows = [
    ...pipeRows(nasdaqText).map(row => ({ ...row, exchange: "NASDAQ" })),
    ...pipeRows(otherText).map(row => ({
      ...row,
      exchange: row.Exchange === "A" ? "AMEX" : row.Exchange === "N" ? "NYSE" : row.Exchange === "P" ? "NYSEArca" : row.Exchange === "Z" ? "CBOE" : "NYSE",
    })),
  ];
  const skipName = /warrant|right|unit|preferred|depositary|notes|%|when issued/i;
  const seen = new Set();
  return rows.flatMap(row => {
    const symbol = String(row.Symbol || row["ACT Symbol"] || "").trim().toUpperCase();
    const name = String(row["Security Name"] || "").trim();
    if (!symbol || !name || row["Test Issue"] !== "N" || /[$\^/]/.test(symbol) || skipName.test(name) || seen.has(symbol)) return [];
    seen.add(symbol);
    const isFund = row.ETF === "Y";
    return [equityRecord({
      id: `YAHOO:${symbol}`,
      provider: "yahoo",
      symbol,
      displaySymbol: symbol,
      description: `${name} ${symbol}`,
      name,
      country: "US",
      exchange: row.exchange,
      currency: "USD",
      tag: isFund ? "ETF" : "美股",
      assetClass: isFund ? "etf" : "stock",
      type: isFund ? "etf" : "stock",
    })];
  });
}

async function naverMarkets(market, suffix, exchange) {
  const first = await requestJson(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=1&pageSize=100`);
  const total = Math.min(Number(first?.totalCount) || 0, 2600);
  const stocks = Array.isArray(first?.stocks) ? [...first.stocks] : [];
  const lastPage = Math.ceil(total / 100);
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= lastPage) {
      const page = nextPage;
      nextPage += 1;
      try {
        const payload = await requestJson(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`);
        if (Array.isArray(payload?.stocks)) stocks.push(...payload.stocks);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(0, lastPage - 1)) }, worker));
  return stocks.flatMap(stock => {
    const code = String(stock?.itemCode || "").trim();
    const name = String(stock?.stockName || "").trim();
    if (!code || !name) return [];
    return [equityRecord({
      id: `YAHOO:${code}.${suffix}`,
      provider: "yahoo",
      symbol: `${code}.${suffix}`,
      displaySymbol: `${name} ${code}`,
      description: name,
      name,
      country: "KR",
      exchange,
      currency: "KRW",
      tag: "韩股",
      assetClass: "stock",
      type: "stock",
      markPrice: Number(String(stock.closePrice || "").replace(/,/g, "")),
      changePercent: Number(stock.fluctuationsRatio),
    })];
  });
}

async function yahooMarkets() {
  const [sec, legacy, kospi, kosdaq] = await Promise.all([
    secUsMarkets().catch(() => []),
    nasdaqTraderMarkets().catch(() => []),
    naverMarkets("KOSPI", "KS", "KRX").catch(() => []),
    naverMarkets("KOSDAQ", "KQ", "KOSDAQ").catch(() => []),
  ]);
  const funds = legacy.filter(market => market.type === "etf");
  const us = sec.length ? [...sec, ...funds] : legacy;
  return [...us, ...kospi, ...kosdaq];
}

async function providerMarkets(provider) {
  switch (provider) {
    case "gate": return gateMarkets();
    case "bybit": return bybitMarkets();
    case "okx": return okxMarkets();
    case "eastmoney": return eastmoneyMarkets();
    case "yahoo": return yahooMarkets();
    default: throw new Error("unsupported market provider");
  }
}

function quoteValue(symbol, current, changePercent) {
  const price = Number(current);
  if (!Number.isFinite(price) || price <= 0) return null;
  const change = Number(changePercent);
  return {
    symbol,
    current: price,
    previousClose: Number.isFinite(change) && change !== -100 ? price / (1 + change / 100) : price,
    changePercent: Number.isFinite(change) ? change : 0,
    unavailable: false,
  };
}

async function gateTickerQuotes() {
  const payload = await requestJson("https://api.gateio.ws/api/v4/spot/tickers");
  const list = Array.isArray(payload) ? payload : [];
  return new Map(list.flatMap(row => {
    const symbol = String(row?.currency_pair || "").toUpperCase();
    const quote = quoteValue(symbol, row?.last, row?.change_percentage);
    return quote ? [[symbol, quote]] : [];
  }));
}

async function bybitTickerQuotes() {
  const payload = await requestJson("https://api.bybit.com/v5/market/tickers?category=spot");
  const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
  return new Map(list.flatMap(row => {
    const symbol = String(row?.symbol || "").toUpperCase();
    const quote = quoteValue(symbol, row?.lastPrice, Number(row?.price24hPcnt) * 100);
    return quote ? [[symbol, quote]] : [];
  }));
}

async function okxTickerQuotes() {
  const payload = await requestJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return new Map(list.flatMap(row => {
    const symbol = String(row?.instId || "").toUpperCase();
    const open = Number(row?.open24h);
    const last = Number(row?.last);
    const change = open > 0 ? (last / open - 1) * 100 : 0;
    const quote = quoteValue(symbol, last, change);
    return quote ? [[symbol, quote]] : [];
  }));
}

async function singleTickerQuote(provider, symbol) {
  if (provider === "gate") {
    const payload = await requestJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`);
    const row = Array.isArray(payload) ? payload[0] : null;
    return quoteValue(symbol, row?.last, row?.change_percentage);
  }
  if (provider === "bybit") {
    const payload = await requestJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`);
    const row = Array.isArray(payload?.result?.list) ? payload.result.list[0] : null;
    return quoteValue(symbol, row?.lastPrice, Number(row?.price24hPcnt) * 100);
  }
  const payload = await requestJson(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  const open = Number(row?.open24h);
  const last = Number(row?.last);
  return quoteValue(symbol, last, open > 0 ? (last / open - 1) * 100 : 0);
}

const SINA_INDEX_ALIASES = {
  "^IXIC": "int_nasdaq",
  "^DJI": "int_dji",
  "^GSPC": "int_sp500",
  "^HSI": "int_hangseng",
  "^N225": "int_nikkei",
  "^FTSE": "int_ftse",
};

function sinaCodeFor(item) {
  const symbol = String(item?.symbol || "").toUpperCase();
  if (SINA_INDEX_ALIASES[symbol]) return SINA_INDEX_ALIASES[symbol];
  if (symbol.endsWith(".HK")) return `hk${symbol.slice(0, -3).padStart(5, "0")}`;
  if (symbol.endsWith(".SH")) return `sh${symbol.slice(0, -3)}`;
  if (symbol.endsWith(".SZ")) return `sz${symbol.slice(0, -3)}`;
  if (symbol.endsWith(".BJ")) return `bj${symbol.slice(0, -3)}`;
  const country = String(item?.country || "").toUpperCase();
  if (symbol.endsWith("=F")) return `hf_${symbol.slice(0, -2)}`;
  if (symbol.endsWith("=X")) return `fx_s${symbol.slice(0, -2).replace(/[^A-Z]/g, "").toLowerCase()}`;
  if ((country === "US" || !country) && /^[A-Z][A-Z0-9]{0,9}$/.test(symbol)) return `gb_${symbol.toLowerCase()}`;
  return "";
}

async function sinaQuoteMap(items) {
  const map = new Map();
  const entries = items.map(item => ({
    symbol: String(item.symbol || "").toUpperCase(),
    code: sinaCodeFor(item),
  })).filter(entry => entry.symbol && entry.code);
  const batches = [];
  for (let offset = 0; offset < entries.length; offset += 100) {
    batches.push(entries.slice(offset, offset + 100));
  }
  let nextBatch = 0;
  const worker = async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      try {
        const text = await requestText(`https://hq.sinajs.cn/list=${batch.map(entry => entry.code).join(",")}`, {
          headers: { referer: "https://finance.sina.com.cn" },
        });
        const byCode = new Map(batch.map(entry => [entry.code, entry]));
        for (const line of text.split(/\r?\n/)) {
          const match = /var hq_str_([a-zA-Z0-9_]+)="([^"]*)"/.exec(line);
          if (!match) continue;
          const entry = byCode.get(match[1]);
          if (!entry) continue;
          const fields = match[2].split(",");
          let quote = null;
          if (match[1].startsWith("hk")) {
            quote = quoteValue(entry.symbol, fields[6], fields[8]);
          } else if (match[1].startsWith("int_")) {
            quote = quoteValue(entry.symbol, fields[1], fields[3]);
          } else if (match[1].startsWith("hf_")) {
            const current = Number(fields[0]);
            const previous = Number(fields[7]);
            const change = previous > 0 ? (current / previous - 1) * 100 : 0;
            quote = quoteValue(entry.symbol, current, change);
          } else if (match[1].startsWith("fx_s")) {
            quote = quoteValue(entry.symbol, fields[1], fields[10]);
          } else if (match[1].startsWith("gb_")) {
            quote = quoteValue(entry.symbol, fields[1], fields[2]);
          } else {
            const current = Number(fields[3]);
            const previous = Number(fields[2]);
            const change = previous > 0 ? (current / previous - 1) * 100 : 0;
            quote = quoteValue(entry.symbol, current, change);
          }
          if (quote) map.set(entry.symbol, quote);
        }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, batches.length)) }, worker));
  return map;
}

let yahooQuoteAuth = { cookie: "", crumb: "", expiresAt: 0 };
const YAHOO_QUOTE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function yahooQuoteSession() {
  if (yahooQuoteAuth.crumb && yahooQuoteAuth.expiresAt > Date.now()) return yahooQuoteAuth;
  const bootstrap = await runtimeFetch("https://fc.yahoo.com", {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": YAHOO_QUOTE_UA, accept: "text/html,*/*" },
  });
  const cookie = (bootstrap.headers.getSetCookie?.() || [])
    .map(value => value.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const crumbResponse = await runtimeFetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": YAHOO_QUOTE_UA, accept: "text/plain,*/*", ...(cookie ? { cookie } : {}) },
  });
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb) throw new Error("Yahoo quote session unavailable");
  yahooQuoteAuth = { cookie, crumb, expiresAt: Date.now() + 30 * 60_000 };
  return yahooQuoteAuth;
}

async function yahooQuoteMap(items) {
  const map = new Map();
  const symbols = [...new Set(items.map(item => String(item?.symbol || "").toUpperCase()).filter(Boolean))];
  if (!symbols.length) return map;
  const batches = [];
  for (let offset = 0; offset < symbols.length; offset += 200) {
    batches.push(symbols.slice(offset, offset + 200));
  }
  let nextBatch = 0;
  let auth = await yahooQuoteSession().catch(() => null);
  if (!auth) return map;
  const worker = async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      try {
        const payload = await requestJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(","))}&crumb=${encodeURIComponent(auth.crumb)}`, {
          headers: { cookie: auth.cookie, "user-agent": YAHOO_QUOTE_UA },
        });
        const rows = Array.isArray(payload?.quoteResponse?.result) ? payload.quoteResponse.result : [];
        for (const row of rows) {
          const symbol = String(row?.symbol || "").toUpperCase();
          const price = Number(row?.regularMarketPrice);
          const previousClose = Number(row?.regularMarketPreviousClose);
          const change = Number(row?.regularMarketChangePercent);
          if (!symbol || !Number.isFinite(price) || price <= 0) continue;
          map.set(symbol, {
            symbol,
            current: price,
            previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : price,
            changePercent: Number.isFinite(change) ? change : 0,
            unavailable: false,
          });
        }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, batches.length)) }, worker));
  return map;
}

async function naverQuoteMap(items) {
  const map = new Map();
  const codes = [...new Set(items
    .filter(item => String(item?.country || "").toUpperCase() === "KR" || /\.(KS|KQ)$/i.test(String(item?.symbol || "")))
    .map(item => String(item.symbol || "").split(".")[0])
    .filter(code => /^\d{6}$/.test(code)))];
  const queue = [...codes];
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        const payload = await requestJson(`https://m.stock.naver.com/api/stock/${code}/basic`);
        const quote = quoteValue(`${code}`, Number(String(payload?.closePrice || "").replace(/,/g, "")), Number(payload?.fluctuationsRatio));
        if (!quote) continue;
        for (const item of items) {
          if (String(item.symbol || "").startsWith(`${code}.`)) {
            map.set(String(item.symbol).toUpperCase(), { ...quote, symbol: String(item.symbol).toUpperCase() });
          }
        }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, codes.length)) }, worker));
  return map;
}

let naverBulkCache = { expiresAt: 0, map: new Map() };
async function naverBulkQuoteMap() {
  if (naverBulkCache.expiresAt > Date.now()) return naverBulkCache.map;
  const entries = [];
  for (const [market, suffix] of [["KOSPI", "KS"], ["KOSDAQ", "KQ"]]) {
    const first = await requestJson(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=1&pageSize=100`);
    const total = Math.min(Number(first?.totalCount) || 0, 2600);
    const stocks = Array.isArray(first?.stocks) ? [...first.stocks] : [];
    const lastPage = Math.ceil(total / 100);
    let nextPage = 2;
    const worker = async () => {
      while (nextPage <= lastPage) {
        const page = nextPage;
        nextPage += 1;
        try {
          const payload = await requestJson(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`);
          if (Array.isArray(payload?.stocks)) stocks.push(...payload.stocks);
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, Math.max(0, lastPage - 1)) }, worker));
    for (const stock of stocks) {
      const code = String(stock?.itemCode || "").trim();
      if (!code) continue;
      const quote = quoteValue(`${code}.${suffix}`, Number(String(stock?.closePrice || "").replace(/,/g, "")), Number(stock?.fluctuationsRatio));
      if (quote) entries.push([quote.symbol, quote]);
    }
  }
  naverBulkCache = { expiresAt: Date.now() + 15_000, map: new Map(entries) };
  return naverBulkCache.map;
}

async function providerCandles(provider, symbol, interval, count, endTime) {
  switch (provider) {
    case "gate": return gateCandles(symbol, interval, count, endTime);
    case "bybit": return bybitCandles(symbol, interval, count, endTime);
    case "okx": return okxCandles(symbol, interval, count, endTime);
    case "yahoo": return yahooCandles(symbol, interval, count, endTime);
    case "eastmoney": return eastmoneyCandles(symbol, interval, count, endTime);
    case "fred": return fredCandles(symbol, count, endTime);
    default: throw new Error("unsupported market provider");
  }
}

export class PublicMarketDataService {
  constructor({ now = Date.now, fetchImpl = null } = {}) {
    this.now = now;
    if (typeof fetchImpl === "function") runtimeFetch = fetchImpl;
    this.cache = new Map();
    this.pending = new Map();
    this.marketCache = new Map();
    this.marketPending = new Map();
    this.tickerCache = new Map();
    this.tickerPending = new Map();
  }

  async getMarkets(params = {}) {
    const provider = String(params.provider || "").trim().toLowerCase();
    if (!MARKET_PROVIDERS.has(provider)) return { ok: false, message: "不支持的交易对目录" };
    const cached = this.marketCache.get(provider);
    if (cached && cached.expiresAt > this.now()) {
      return { ok: true, provider, markets: cached.markets, cached: true };
    }
    if (this.marketPending.has(provider)) return this.marketPending.get(provider);
    const task = (async () => {
      try {
        const markets = (await providerMarkets(provider)).slice(0, MAX_MARKETS);
        if (!markets.length) throw new Error("empty market catalog");
        this.marketCache.set(provider, { markets, expiresAt: this.now() + MARKET_CACHE_TTL_MS });
        return { ok: true, provider, markets };
      } catch (error) {
        const previous = this.marketCache.get(provider);
        if (previous?.markets?.length) {
          return { ok: true, provider, markets: previous.markets, stale: true };
        }
        return { ok: false, provider, message: String(error?.message || "交易对目录加载失败") };
      } finally {
        this.marketPending.delete(provider);
      }
    })();
    this.marketPending.set(provider, task);
    return task;
  }

  async getCandles(params = {}) {
    const provider = String(params.provider || "").trim().toLowerCase();
    const symbol = cleanSymbol(params.symbol);
    const interval = String(params.resolution || params.interval || "60").trim();
    const count = Math.min(MAX_COUNT, Math.max(2, Number(params.count) || 300));
    const endTime = Number(params.endTime) > 0 ? Math.floor(Number(params.endTime)) : 0;
    if (!PROVIDERS.has(provider)) return { ok: false, message: "不支持的行情源" };
    if (!/^[A-Z0-9^:._/\-=]{1,96}$/.test(symbol)) return { ok: false, message: "无效的行情代码" };
    const key = `${provider}|${symbol}|${interval}|${count}|${endTime}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return { ok: true, candles: cached.candles, cached: true };
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        const candles = await providerCandles(provider, symbol, interval, count, endTime || undefined);
        if (!candles.length) throw new Error("empty market response");
        this.cache.set(key, { candles, expiresAt: this.now() + CACHE_TTL_MS });
        return { ok: true, candles };
      } catch (error) {
        const previous = this.cache.get(key);
        if (previous?.candles?.length) return { ok: true, candles: previous.candles, stale: true };
        return { ok: false, message: String(error?.message || "行情加载失败") };
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  async getQuote(provider, symbol) {
    const daily = await this.getCandles({ provider, symbol, resolution: "1D", count: 3 });
    if (daily.ok !== true) return { symbol, unavailable: true };
    const candles = daily.candles;
    const last = candles.at(-1);
    const previous = candles.at(-2);
    if (!last) return { symbol, unavailable: true };
    const current = last.close;
    const previousClose = previous?.close ?? last.open;
    const changePercent = previousClose > 0 ? (current / previousClose - 1) * 100 : 0;
    return { symbol, current, previousClose, changePercent, unavailable: false };
  }

  async tickerQuotes(provider) {
    const cached = this.tickerCache.get(provider);
    if (cached && cached.expiresAt > this.now()) return cached.map;
    if (this.tickerPending.has(provider)) return this.tickerPending.get(provider);
    const task = (async () => {
      try {
        const map = provider === "gate" ? await gateTickerQuotes()
          : provider === "bybit" ? await bybitTickerQuotes()
            : await okxTickerQuotes();
        this.tickerCache.set(provider, { map, expiresAt: this.now() + 900 });
        return map;
      } finally {
        this.tickerPending.delete(provider);
      }
    })();
    this.tickerPending.set(provider, task);
    return task;
  }

  async getQuotes(params = {}) {
    const provider = String(params.provider || "").trim().toLowerCase();
    if (!PROVIDERS.has(provider)) return { ok: false, message: "不支持的行情源" };
    const rawItems = Array.isArray(params.items) && params.items.length
      ? params.items
      : (Array.isArray(params.symbols) ? params.symbols : []).map(symbol => ({ symbol }));
    const items = [...new Map(rawItems
      .map(item => ({
        symbol: cleanSymbol(item?.symbol),
        exchange: String(item?.exchange || "").trim(),
        country: String(item?.country || "").trim().toUpperCase(),
      }))
      .filter(item => item.symbol && /^[A-Z0-9^:._/\-=]{1,96}$/.test(item.symbol))
      .map(item => [item.symbol, item])).values()].slice(0, 20000);
    if (!items.length) return { ok: true, quotes: [] };
    const map = new Map();
    try {
      if (provider === "gate" || provider === "bybit" || provider === "okx") {
        if (params.fast === true && items.length <= 20) {
          const queue = [...items];
          const worker = async () => {
            while (queue.length) {
              const item = queue.shift();
              try {
                const quote = await singleTickerQuote(provider, item.symbol);
                if (quote) map.set(item.symbol, quote);
              } catch {}
            }
          };
          await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
        } else {
          const tickers = await this.tickerQuotes(provider);
          for (const item of items) {
            const quote = tickers.get(item.symbol);
            if (quote) map.set(item.symbol, quote);
          }
        }
      } else if (provider === "eastmoney") {
        for (const [symbol, quote] of await sinaQuoteMap(items)) map.set(symbol, quote);
      } else if (provider === "yahoo") {
        for (const [symbol, quote] of await yahooQuoteMap(items)) map.set(symbol, quote);
        const missing = items.filter(item => !map.has(item.symbol));
        if (missing.length) {
          const kr = missing.filter(item => item.country === "KR" || /\.(KS|KQ)$/i.test(item.symbol));
          const sinaItems = missing.filter(item => !kr.includes(item) && sinaCodeFor(item));
          const [sinaMap, krMap] = await Promise.all([
            sinaQuoteMap(sinaItems),
            kr.length <= 40 ? naverQuoteMap(kr) : naverBulkQuoteMap(),
          ]);
          for (const [symbol, quote] of sinaMap) map.set(symbol, quote);
          for (const [symbol, quote] of krMap) map.set(symbol, quote);
        }
        const other = items.filter(item => !map.has(item.symbol) && !sinaCodeFor(item));
        if (params.fast !== true && other.length <= 40) {
          for (const item of other) {
            const quote = await this.getQuote(provider, item.symbol).catch(() => null);
            if (quote && quote.unavailable !== true) map.set(item.symbol, quote);
          }
        }
      } else if (provider === "fred" && params.fast !== true && items.length <= 40) {
        for (const item of items) {
          const quote = await this.getQuote(provider, item.symbol).catch(() => null);
          if (quote && quote.unavailable !== true) map.set(item.symbol, quote);
        }
      }
    } catch {}
    return {
      ok: true,
      quotes: items.map(item => map.get(item.symbol) || { symbol: item.symbol, unavailable: true }),
    };
  }
}