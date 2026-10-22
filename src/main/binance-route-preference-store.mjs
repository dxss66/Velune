import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const ALLOWED_ROUTE_KEYS = new Set([
  "public:spot",
  "public:futures",
  "private:spot",
  "private:futures",
]);

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0;
}

function normalizedStates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const states = {};
  for (const [key, state] of Object.entries(value)) {
    if (!ALLOWED_ROUTE_KEYS.has(key) || !state || typeof state !== "object" || Array.isArray(state)) continue;
    states[key] = {
      failures: Math.max(0, Math.min(20, Math.trunc(Number(state.failures) || 0))),
      cooldownUntil: finiteTimestamp(state.cooldownUntil),
      gatewayPreferredUntil: finiteTimestamp(state.gatewayPreferredUntil),
    };
  }
  return states;
}

export class BinanceRoutePreferenceStore {
  constructor({ storagePath, now = Date.now, writeDelayMs = 250 } = {}) {
    if (!storagePath) throw new TypeError("storagePath is required");
    this.storagePath = path.resolve(String(storagePath));
    this.now = now;
    this.writeDelayMs = Math.max(0, Number(writeDelayMs) || 0);
    this.pendingStates = null;
    this.writeTimer = null;
  }

  currentTimeMs() {
    const value = typeof this.now === "function" ? this.now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value) || Date.now();
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return {};
      const payload = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
      if (Number(payload?.version) !== STORE_VERSION) return {};
      return normalizedStates(payload.states);
    } catch {
      // A damaged preference file must never prevent the trading screen from
      // starting. The next route transition atomically replaces it.
      return {};
    }
  }

  schedule(states) {
    this.pendingStates = normalizedStates(states);
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, this.writeDelayMs);
    this.writeTimer.unref?.();
  }

  flush() {
    if (!this.pendingStates) return;
    const states = this.pendingStates;
    this.pendingStates = null;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${this.currentTimeMs()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify({
        version: STORE_VERSION,
        updatedAt: this.currentTimeMs(),
        states,
      })}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.storagePath);
    } finally {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    }
  }

  close() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
  }
}

export { ALLOWED_ROUTE_KEYS, STORE_VERSION };
