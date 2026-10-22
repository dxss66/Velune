import { PublicMarketIndicesService } from "./public-market-indices.mjs";
import { PRIORITY_INDICES, indexPlaceholders } from "../shared/market-index-catalog.mjs";

const equivalent = new Map([
  ["index:fear-greed", "alternative:fng"],
  ["index:binance-btc-long-short", "binance:btc:accounts"],
]);
const priorities = new Map(PRIORITY_INDICES.map(item => [item.id, item.priority]));
const stale = item => ({ ...item, status: item.value === null ? "error" : "stale" });

/** Only Velune's authenticated backend can access the vendor. No vendor keys here. */
export class MarketIndicesService {
  constructor({ indicesRequest, now = Date.now, ...publicOptions }) {
    this.public = new PublicMarketIndicesService({ ...publicOptions, now });
    this.request = indicesRequest;
    this.now = now;
    this.catalogue = indexPlaceholders();
    this.expiresAt = 0;
    this.pending = null;
  }

  async loadCatalogue() {
    if (this.expiresAt > this.now()) return this.catalogue;
    try {
      const snapshot = await this.request();
      if (!Array.isArray(snapshot?.indices) || !snapshot.indices.length) throw Error("Index service unavailable");
      const byId = new Map();
      for (const item of snapshot.indices) {
        if (!item || typeof item.id !== "string" || !item.id.startsWith("index:")
          || typeof item.name !== "string" || typeof item.code !== "string") continue;
        const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
        const value = finite(item.value);
        byId.set(item.id, { id: item.id, name: item.name, enName: item.enName, code: item.code,
          intervalMs: finite(item.intervalMs) ?? 0, value, changePercent: value === null ? null : finite(item.changePercent),
          change24H: value === null ? null : finite(item.change24H), updatedAt: finite(item.updatedAt),
          fetchedAt: finite(item.fetchedAt), description: "", series: [],
          status: value === null ? "error" : item.status === "ready" ? "ready" : "stale",
          priority: priorities.get(item.id) ?? null });
      }
      if (!byId.size) throw Error("Index service unavailable");
      for (const placeholder of indexPlaceholders()) {
        if (!byId.has(placeholder.id)) byId.set(placeholder.id, stale(this.catalogue.find(item => item.id === placeholder.id) || placeholder));
      }
      this.catalogue = [...byId.values()];
    } catch {
      this.catalogue = this.catalogue.map(stale);
    }
    this.expiresAt = this.now() + 60_000;
    return this.catalogue;
  }

  async snapshot() {
    if (!this.pending) this.pending = (async () => {
      const [catalogue, publicSnapshot] = await Promise.all([this.loadCatalogue(), this.public.snapshot()]);
      const extra = new Map(publicSnapshot.indices.map(item => [item.id, item]));
      const indices = catalogue.map(item => {
        const alternativeId = equivalent.get(item.id);
        const fallback = extra.get(alternativeId);
        if (alternativeId) extra.delete(alternativeId);
        if (item.status !== "ready" && fallback?.status === "ready") {
          return { ...fallback, id: item.id, name: item.name, enName: item.enName, priority: item.priority };
        }
        return item;
      });
      indices.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
      return { indices: [...indices, ...extra.values()], fetchedAt: this.now() };
    })().finally(() => { this.pending = null; });
    return structuredClone(await this.pending);
  }
}
