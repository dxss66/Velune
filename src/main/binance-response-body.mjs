import { withAbort } from "./system-proxy-fetch.mjs";

export const MAX_BINANCE_RESPONSE_BYTES = 16 * 1024 * 1024;

// Cancellation can wait for other tee readers. Start it without delaying a
// winning route or an expired request, and always observe its rejection.
export function discardBinanceResponse(response, reason) {
  try { void Promise.resolve(response?.body?.cancel(reason)).catch(() => {}); } catch {}
}

export function fetchBinanceResponse(fetchImpl, input, init = {}) {
  const signal = init.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const pending = Promise.resolve().then(() => {
    signal?.throwIfAborted();
    return fetchImpl(input, init);
  }).then((response) => {
    if (signal?.aborted) {
      discardBinanceResponse(response, signal.reason);
      throw signal.reason;
    }
    return response;
  });
  return withAbort(pending, signal);
}

// Binance REST returns finite JSON, so keep the concurrency slot and deadline
// until all bytes arrive. Model/SSE/WebSocket traffic never enters this helper.
export async function bufferBinanceResponse(response, { signal, maxBytes = MAX_BINANCE_RESPONSE_BYTES } = {}) {
  if (signal?.aborted) {
    discardBinanceResponse(response, signal.reason);
    throw signal.reason;
  }
  if (!response?.body) return response;
  const reader = response.body.getReader();
  const cancel = (reason) => { void reader.cancel(reason).catch(() => {}); };
  const abort = () => cancel(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await withAbort(reader.read(), signal);
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Binance response exceeded ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
    return new Response(Buffer.concat(chunks, size), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
