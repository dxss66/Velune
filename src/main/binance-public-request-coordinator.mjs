const REQUEST_ID_PATTERN = /^renderer-market-rest-[a-z0-9-]{8,120}$/i;

function ownerKey(ownerId, requestId) {
  const normalizedOwnerId = Number(ownerId);
  if (!Number.isSafeInteger(normalizedOwnerId) || normalizedOwnerId < 1) {
    throw new TypeError("invalid Binance market request owner");
  }
  const normalizedRequestId = String(requestId || "").trim();
  if (!REQUEST_ID_PATTERN.test(normalizedRequestId)) {
    throw new TypeError("invalid Binance market request id");
  }
  return `${normalizedOwnerId}\u0000${normalizedRequestId}`;
}

function cancellationError() {
  return new DOMException("The Binance market request was cancelled", "AbortError");
}

/**
 * Owns renderer-initiated public REST requests in the trusted main process.
 * Renderer AbortSignals cannot cross Electron IPC, so the preload sends an
 * explicit cancellation message and this coordinator aborts the real fetch.
 */
export class BinancePublicRequestCoordinator {
  constructor() {
    this.pending = new Map();
  }

  begin(ownerId, requestId) {
    const key = ownerKey(ownerId, requestId);
    this.pending.get(key)?.controller.abort(cancellationError());
    const controller = new AbortController();
    const entry = { ownerId: Number(ownerId), controller };
    this.pending.set(key, entry);
    let finished = false;
    return Object.freeze({
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.pending.get(key) === entry) this.pending.delete(key);
      },
    });
  }

  cancel(ownerId, requestId) {
    const key = ownerKey(ownerId, requestId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    entry.controller.abort(cancellationError());
    return true;
  }

  cancelOwner(ownerId) {
    const normalizedOwnerId = Number(ownerId);
    let cancelled = 0;
    for (const [key, entry] of this.pending) {
      if (entry.ownerId !== normalizedOwnerId) continue;
      this.pending.delete(key);
      entry.controller.abort(cancellationError());
      cancelled += 1;
    }
    return cancelled;
  }

  cancelAll() {
    let cancelled = 0;
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      entry.controller.abort(cancellationError());
      cancelled += 1;
    }
    return cancelled;
  }

  snapshot() {
    return Object.freeze({ pending: this.pending.size });
  }
}
