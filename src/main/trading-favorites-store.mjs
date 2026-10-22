import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_ITEMS = 5000;
const MAX_TEXT_LENGTH = 160;

function text(value, maxLength = MAX_TEXT_LENGTH) {
  const normalized = String(value ?? "").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeMarketType(value) {
  const normalized = text(value, 32).toLowerCase();
  if (normalized === "spot") return "spot";
  if (normalized === "perpetual" || normalized === "futures") return "perpetual";
  return "";
}

function favoriteId(provider, symbol, marketType) {
  if (provider === "binance") return `binance:${marketType === "spot" ? "spot" : "usdm"}:${symbol}`;
  return `${provider}:${symbol}`;
}

export function normalizeFavoriteItem(value = {}) {
  if (!value || typeof value !== "object") return null;
  const provider = text(value.provider, 32).toLowerCase();
  const symbol = text(value.symbol, 64).toUpperCase();
  if (!provider || !symbol) return null;
  const marketType = normalizeMarketType(value.marketType);
  const baseAsset = text(value.baseAsset, 32) || symbol;
  return {
    id: text(value.id, MAX_TEXT_LENGTH) || favoriteId(provider, symbol, marketType),
    provider,
    symbol,
    baseAsset,
    quoteAsset: text(value.quoteAsset, 32) || (provider === "binance" ? "USDT" : ""),
    displaySymbol: text(value.displaySymbol, 64) || baseAsset,
    description: text(value.description, 160) || baseAsset,
    venue: text(value.venue, 64),
    assetClass: text(value.assetClass, 64),
    marketType,
    perpetual: marketType === "perpetual" || value.perpetual === true,
  };
}

function cloneItem(item) {
  return { ...item };
}

/**
 * Watchlist favorites are local-only in the stripped-down build: the renderer
 * still talks to the same four IPC channels, but the backing store is a JSON
 * file in userData instead of the removed remote account service.
 */
export class TradingFavoritesStore {
  constructor({ filePath, now = Date.now } = {}) {
    if (!filePath) throw new TypeError("TradingFavoritesStore requires a filePath");
    this.filePath = filePath;
    this.now = now;
    this.state = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items)
        ? parsed.items.map(normalizeFavoriteItem).filter(Boolean).slice(0, MAX_ITEMS)
        : [];
      return {
        initialized: true,
        version: Number.isSafeInteger(parsed?.version) ? parsed.version : items.length,
        items: dedupe(items),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") this.quarantineCorruptFile(error);
      return { initialized: false, version: 0, items: [] };
    }
  }

  quarantineCorruptFile(error) {
    try {
      const quarantinePath = `${this.filePath}.corrupt-${this.now()}`;
      fs.renameSync(this.filePath, quarantinePath);
      console.warn("[trading-favorites] moved corrupt store aside", quarantinePath, error?.message || error);
    } catch {
      // A read-only or locked file must not prevent the app from starting.
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify({
      version: this.state.version,
      initialized: this.state.initialized,
      items: this.state.items,
    }, null, 2);
    fs.writeFileSync(temporaryPath, payload, "utf8");
    fs.rmSync(this.filePath, { force: true });
    fs.renameSync(temporaryPath, this.filePath);
  }

  list() {
    return {
      initialized: this.state.initialized,
      version: this.state.version,
      items: this.state.items.map(cloneItem),
    };
  }

  add(params = {}) {
    const item = normalizeFavoriteItem(params);
    if (!item) return { ok: false, error: "INVALID_FAVORITE", version: this.state.version, items: this.list().items };
    const index = this.state.items.findIndex(existing => existing.id === item.id);
    if (index >= 0) this.state.items[index] = item;
    else if (this.state.items.length < MAX_ITEMS) this.state.items.push(item);
    else return { ok: false, error: "FAVORITES_FULL", version: this.state.version, items: this.list().items };
    this.state.initialized = true;
    this.state.version += 1;
    this.persist();
    return { ok: true, version: this.state.version, item: cloneItem(item) };
  }

  remove(params = {}) {
    const marketId = text(params.marketId, MAX_TEXT_LENGTH);
    if (!marketId) return { ok: false, error: "INVALID_MARKET_ID", version: this.state.version };
    const before = this.state.items.length;
    this.state.items = this.state.items.filter(item => item.id !== marketId);
    const removed = this.state.items.length !== before;
    if (!removed) return { ok: true, removed: false, version: this.state.version };
    this.state.version += 1;
    this.persist();
    return { ok: true, removed: true, version: this.state.version };
  }

  reorder(params = {}) {
    const marketIds = Array.isArray(params.marketIds) ? params.marketIds.map(value => text(value)) : [];
    if (!marketIds.length) return { ok: false, error: "INVALID_MARKET_IDS", version: this.state.version };
    const position = new Map(marketIds.map((id, index) => [id, index]));
    const ordered = [...this.state.items].sort((left, right) => {
      const leftPosition = position.has(left.id) ? position.get(left.id) : Number.MAX_SAFE_INTEGER;
      const rightPosition = position.has(right.id) ? position.get(right.id) : Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition;
    });
    this.state.items = ordered;
    this.state.version += 1;
    this.persist();
    return { ok: true, version: this.state.version };
  }
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export { STORE_VERSION, MAX_ITEMS };