// Stable product identifiers and display order, shared with the mobile API.
export const PRIORITY_INDICES = Object.freeze([
  ["nasdaq-composite", "纳斯达克综合指数", "NASDAQ Composite Index", "IXIC"],
  ["nasdaq-futures", "纳斯达克指数期货CFD", "Nasdaq Index Futures CFD", "NQ"],
  ["btc-ahr999", "BTC-ahr999囤币指数", "BTC-ahr999 Index", "ahr999"],
  ["gold", "伦敦金", "XAUUSD", "XAUUSD"],
  ["silver", "伦敦银", "XAG", "XAG"],
  ["fear-greed", "恐惧与贪婪指数", "Crypto Fear & Greed Index", "FGI"],
  ["okx-btc-long-short", "OKX-BTC多空持仓人数比", "OKX-BTC Long/Short Ratio", "BTC L/S"],
  ["binance-btc-long-short", "币安-BTC永续多空持仓人数比", "Binance-BTC Swap Long/Short Ratio", "BTC Swap L/S"],
  ["sp500", "标准普尔500指数", "S&P 500 Index", "SPX"],
].map(([key, name, enName, code], priority) => Object.freeze({
  id: `index:${key}`, name, enName, code, priority, description: "",
  intervalMs: key === "fear-greed" ? 86_400_000 : 0,
})));

export function indexPlaceholders() {
  return PRIORITY_INDICES.map(item => ({ ...item, value: null, changePercent: null,
    change24H: null, updatedAt: null, fetchedAt: null, series: [], status: "error" }));
}
