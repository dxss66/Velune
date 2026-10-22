import WebSocket from "ws";
import { decodeMarketPayload } from "./market-wire-codec.mjs";

const STREAM_PATTERN = /^[a-z0-9_\p{Script=Han}]{2,40}@(kline_(?:1s|[1-9]\d*[mhdwM])|ticker|miniTicker|aggTrade|bookTicker|markPrice(?:@1s)?)$/u;

function marketTypeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "spot") return "spot";
  if (normalized === "futures" || normalized === "perpetual") return "futures";
  throw new TypeError("unsupported Binance market type");
}

function streamValue(value) {
  const normalized = String(value || "").trim();
  if (!STREAM_PATTERN.test(normalized)) throw new TypeError(`unsupported Binance stream: ${normalized}`);
  return normalized;
}

function streamClassValue(value) {
  const stream = streamValue(value);
  return /@bookTicker$/.test(stream) ? "public" : "market";
}

function channelKey(marketType, streamClass) {
  return `${marketType}:${streamClass}`;
}

export class TradingMarketDataHub {
  constructor({
    endpointProvider,
    endpointFailureReporter = null,
    lookupProvider = null,
    WebSocketImpl = WebSocket,
    reconnectBaseMs = 500,
    heartbeatMs = 20_000,
    handshakeTimeoutMs = 8_000,
    idleCloseMs = 500,
    closeTimeoutMs = 2_000,
    subscriptionAckTimeoutMs = 5_000,
  } = {}) {
    if (typeof endpointProvider !== "function") throw new TypeError("endpointProvider is required");
    if (endpointFailureReporter != null && typeof endpointFailureReporter !== "function") {
      throw new TypeError("endpointFailureReporter must be a function");
    }
    if (lookupProvider != null && typeof lookupProvider !== "function") {
      throw new TypeError("lookupProvider must be a function");
    }
    this.endpointProvider = endpointProvider;
    this.endpointFailureReporter = endpointFailureReporter;
    this.lookupProvider = lookupProvider;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectBaseMs = Math.max(10, Number(reconnectBaseMs) || 500);
    this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || 20_000);
    this.handshakeTimeoutMs = Math.max(250, Number(handshakeTimeoutMs) || 8_000);
    this.idleCloseMs = Math.max(0, Number(idleCloseMs) || 0);
    this.closeTimeoutMs = Math.max(10, Number(closeTimeoutMs) || 2_000);
    this.subscriptionAckTimeoutMs = Math.max(10, Number(subscriptionAckTimeoutMs) || 5_000);
    // Binance limits client-to-server commands to 10 messages/second. A
    // short debounce absorbs favorite/split-pane churn into one batched
    // SUBSCRIBE/UNSUBSCRIBE frame without delaying the market feed itself.
    this.commandDebounceMs = 120;
    this.channels = new Map();
    this.nextSubscriptionId = 1;
    this.nextRequestId = 1;
    this.closed = false;
  }

  channelFor(marketType, streamClass = "market") {
    const normalized = marketTypeValue(marketType);
    const key = channelKey(normalized, streamClass);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        marketType: normalized,
        streamClass,
        subscriptions: new Map(),
        streamSubscriptions: new Map(),
        socket: null,
        connecting: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        heartbeatTimer: null,
        handshakeTimer: null,
        pendingCommands: [],
        commandTimer: null,
        alive: true,
        generation: 0,
        idleTimer: null,
        closing: null,
        normalClose: false,
        pendingAcks: new Map(),
        acknowledgedStreams: new Set(),
        ready: false,
        retryAfterMs: 0,
        failureReason: null,
      };
      this.channels.set(key, channel);
    }
    return channel;
  }

  isOpen(socket) {
    return socket?.readyState === (this.WebSocketImpl.OPEN ?? 1);
  }

  sendCommand(channel, method, streams) {
    if (!this.isOpen(channel.socket) || !streams.length) return;
    const socket = channel.socket;
    const id = this.nextRequestId++;
    const timer = setTimeout(() => {
      if (channel.socket === socket && channel.pendingAcks.has(id)) this.failSubscription(channel, "subscription_ack_timeout");
    }, this.subscriptionAckTimeoutMs);
    timer.unref?.();
    channel.pendingAcks.set(id, { method, streams, timer });
    try {
      socket.send(JSON.stringify({ method, params: streams, id }));
    } catch { this.failSubscription(channel, "subscription_send_failed"); }
  }

  clearAcknowledgements(channel) {
    for (const request of channel.pendingAcks.values()) clearTimeout(request.timer);
    channel.pendingAcks.clear();
    channel.acknowledgedStreams.clear();
    channel.ready = false;
  }

  failSubscription(channel, reason) {
    channel.failureReason = reason;
    channel.ready = false;
    this.broadcastHealth(channel, { status: "reconnecting", reason });
    void this.closeSocket(channel, 1011, reason);
  }

  closeSocket(channel, code = 1000, reason = "unused") {
    if (channel.closing) return channel.closing;
    const socket = channel.socket;
    if (!socket || socket.readyState === 3) return Promise.resolve();
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    channel.closing = closed;
    const timer = setTimeout(() => { try { socket.terminate(); } catch {} }, this.closeTimeoutMs);
    // Keep the bounded shutdown alive even if no other handles remain.
    socket.once("close", () => { clearTimeout(timer); channel.closing = null; finish(); });
    try {
      if (socket.readyState === (this.WebSocketImpl.CONNECTING ?? 0)) socket.terminate();
      else socket.close(code, reason);
    } catch { try { socket.terminate(); } catch {} }
    return closed;
  }

  retireIdleChannel(channel) {
    if (channel.subscriptions.size) return;
    channel.generation += 1;
    clearTimeout(channel.reconnectTimer);
    clearTimeout(channel.commandTimer);
    channel.reconnectTimer = channel.commandTimer = null;
    channel.pendingCommands = [];
    this.clearAcknowledgements(channel);
    channel.normalClose = true;
    if (channel.socket) void this.closeSocket(channel);
    else if (this.channels.get(channelKey(channel.marketType, channel.streamClass)) === channel) {
      this.channels.delete(channelKey(channel.marketType, channel.streamClass));
    }
  }

  queueCommand(channel, method, streams) {
    if (!streams.length) return;
    channel.pendingCommands.push({ method, streams });
    if (channel.commandTimer !== null) return;
    channel.commandTimer = setTimeout(() => {
      channel.commandTimer = null;
      const intents = new Map();
      for (const command of channel.pendingCommands.splice(0)) {
        command.streams.forEach((stream) => intents.set(stream, command.method));
      }
      const grouped = new Map();
      for (const [stream, queuedMethod] of intents) {
        if (!grouped.has(queuedMethod)) grouped.set(queuedMethod, []);
        grouped.get(queuedMethod).push(stream);
      }
      for (const [queuedMethod, queuedStreams] of grouped) {
        this.sendCommand(channel, queuedMethod, queuedStreams);
      }
    }, this.commandDebounceMs);
    channel.commandTimer.unref?.();
  }

  broadcastHealth(channel, health) {
    const frozen = Object.freeze({ type: "health", at: Date.now(), ...health });
    for (const subscription of channel.subscriptions.values()) {
      try { subscription.onHealth(frozen); } catch {}
    }
  }

  scheduleReconnect(channel, reason = "websocket_closed") {
    if (this.closed || !channel.subscriptions.size || channel.reconnectTimer) return;
    this.broadcastHealth(channel, { status: "reconnecting", reason });
    const delay = Math.max(channel.retryAfterMs, Math.min(30_000, this.reconnectBaseMs * 2 ** Math.min(channel.reconnectAttempt++, 6)));
    channel.retryAfterMs = 0;
    channel.reconnectTimer = setTimeout(() => {
      channel.reconnectTimer = null;
      void this.connect(channel);
    }, delay);
    channel.reconnectTimer.unref?.();
  }

  armHeartbeat(channel, socket) {
    clearInterval(channel.heartbeatTimer);
    channel.alive = true;
    channel.heartbeatTimer = setInterval(() => {
      if (channel.socket !== socket || !this.isOpen(socket)) return;
      if (!channel.alive) {
        try { socket.terminate?.(); } catch { try { socket.close(); } catch {} }
        return;
      }
      channel.alive = false;
      try { socket.ping?.(); } catch { try { socket.close(); } catch {} }
    }, this.heartbeatMs);
    channel.heartbeatTimer.unref?.();
  }

  async connect(channel) {
    if (this.closed || channel.connecting || channel.socket || channel.closing || channel.reconnectTimer || !channel.subscriptions.size) return;
    channel.connecting = true;
    const generation = ++channel.generation;
    let endpoint;
    let endpointContext;
    try {
      const resolved = await this.endpointProvider({
        marketType: channel.marketType,
        combined: true,
        streamClass: channel.streamClass,
      });
      endpointContext = typeof resolved === "string"
        ? { url: resolved, route: null, marketType: channel.marketType }
        : { ...resolved, marketType: resolved?.marketType || channel.marketType };
      endpoint = String(endpointContext?.url || "");
      if (!endpoint) throw new Error("market endpoint is empty");
      if (endpointContext.route === "gateway" && Number.isFinite(endpointContext.ticketExpiresAt)
          && endpointContext.ticketExpiresAt <= Date.now() + 1_000) {
        throw Object.assign(new Error("Market WebSocket ticket expired before connect"), { code: "WS_TICKET_EXPIRED" });
      }
    } catch (error) {
      channel.connecting = false;
      this.scheduleReconnect(channel, error?.code === "WS_TICKET_EXPIRED" ? error.code : String(error?.message || "endpoint_failed").slice(0, 240));
      return;
    }
    if (this.closed || generation !== channel.generation || channel.socket || !channel.subscriptions.size) {
      channel.connecting = false;
      return;
    }
    let socket;
    let lookup;
    try {
      lookup = this.lookupProvider?.(endpointContext);
      socket = new this.WebSocketImpl(endpoint, {
        perMessageDeflate: false,
        maxPayload: 1024 * 1024,
        handshakeTimeout: this.handshakeTimeoutMs,
        ...(endpointContext.route === "gateway" && Number.isFinite(endpointContext.ticketExpiresAt)
          ? { veluneMarketTicketExpiresAt: endpointContext.ticketExpiresAt } : {}),
        ...(typeof lookup === "function" ? { family: 4, lookup } : {}),
      });
    } catch (error) {
      channel.connecting = false;
      if (error?.code !== "WS_TICKET_EXPIRED" && endpointContext?.route === "gateway") lookup?.invalidate?.(new URL(endpoint).hostname);
      this.reportEndpointOutcome({ ...endpointContext, outcome: "failed", connectedDurationMs: 0 });
      this.scheduleReconnect(channel, String(error?.message || "connect_failed").slice(0, 240));
      return;
    }
    channel.socket = socket;
    channel.normalClose = false;
    channel.failureReason = null;
    channel.connecting = false;
    // Bound DNS/TCP/TLS/upgrade together; an HTTP socket timeout alone may not
    // cover a stalled connect on every Node/Electron platform.
    channel.handshakeTimer = setTimeout(() => {
      if (channel.socket !== socket || this.isOpen(socket)) return;
      try { socket.terminate(); } catch { try { socket.close(); } catch {} }
    }, this.handshakeTimeoutMs);
    channel.handshakeTimer.unref?.();
    let openedAt = 0, routeChanged = false, handshakeStatus = 0;
    socket.on("unexpected-response", (_request, response) => {
      if (channel.socket !== socket) { response.destroy(); return; }
      handshakeStatus = Number(response.statusCode) || 0;
      const knownCodes = new Set(["WS_USER_CONNECTION_LIMIT", "WS_CONNECTION_RATE_LIMIT", "WS_TOTAL_CONNECTION_LIMIT",
        "WS_TICKET_EXPIRED", "WS_TICKET_CONSUMED", "WS_TICKET_UNKNOWN", "WS_TICKET_INVALID", "WS_TICKET_UNAVAILABLE"]);
      const code = response.headers?.["x-velune-error-code"];
      channel.failureReason = knownCodes.has(code) ? code : `websocket_http_${handshakeStatus}`;
      const retrySeconds = Number(response.headers?.["retry-after"]);
      channel.retryAfterMs = Number.isFinite(retrySeconds) ? Math.min(60_000, Math.max(0, retrySeconds * 1_000)) : 0;
      response.destroy();
      socket.terminate();
    });
    socket.on("velune-route-change", () => { routeChanged = true; });
    socket.on("open", () => {
      if (channel.socket !== socket || this.closed || routeChanged) return;
      clearTimeout(channel.handshakeTimer);
      channel.handshakeTimer = null;
      openedAt = Date.now();
      channel.alive = true;
      this.clearAcknowledgements(channel);
      // The open handshake sends the authoritative current stream set. Drop
      // commands queued while CONNECTING so they cannot replay a duplicate
      // SUBSCRIBE after the socket has already been initialized.
      clearTimeout(channel.commandTimer);
      channel.commandTimer = null;
      channel.pendingCommands = [];
      this.sendCommand(channel, "SUBSCRIBE", [...channel.streamSubscriptions.keys()]);
      this.armHeartbeat(channel, socket);
      this.reportEndpointOutcome({ ...endpointContext, outcome: "connected", connectedDurationMs: 0 });
    });
    socket.on("pong", () => {
      if (channel.socket === socket) channel.alive = true;
    });
    socket.on("message", (payload) => {
      if (channel.socket !== socket || this.closed || routeChanged) return;
      channel.alive = true;
      let message;
      try { message = decodeMarketPayload(JSON.parse(String(payload))); } catch {
        // A malformed negotiated frame must cause recovery, not silent data loss.
        try { socket.close(1002, "invalid_market_frame"); } catch {}
        return;
      }
      const acknowledgement = channel.pendingAcks.get(message?.id);
      if (acknowledgement) {
        clearTimeout(acknowledgement.timer);
        channel.pendingAcks.delete(message.id);
        if (message.code != null || message.error != null || message.result !== null) {
          this.failSubscription(channel, "subscription_rejected");
          return;
        }
        for (const stream of acknowledgement.streams) {
          if (acknowledgement.method === "SUBSCRIBE") channel.acknowledgedStreams.add(stream);
          else channel.acknowledgedStreams.delete(stream);
        }
        if ([...channel.streamSubscriptions.keys()].every(stream => channel.acknowledgedStreams.has(stream)) && channel.subscriptions.size) {
          channel.ready = true;
          channel.reconnectAttempt = 0;
          this.broadcastHealth(channel, { status: "connected" });
        }
        return;
      }
      const stream = String(message?.stream || "");
      if (!stream) return;
      const event = Object.freeze({
        type: "data",
        stream,
        data: message.data,
        receivedAt: Date.now(),
      });
      for (const subscriptionId of channel.streamSubscriptions.get(stream) || []) {
        const subscription = channel.subscriptions.get(subscriptionId);
        try { subscription?.onEvent(event); } catch {}
      }
    });
    socket.on("error", error => {
      if (error?.code === "WS_TICKET_EXPIRED") channel.failureReason = error.code;
      try { socket.close(); } catch {}
    });
    socket.on("close", () => {
      if (channel.socket !== socket) return;
      channel.socket = null;
      this.clearAcknowledgements(channel);
      clearTimeout(channel.handshakeTimer);
      channel.handshakeTimer = null;
      clearInterval(channel.heartbeatTimer);
      channel.heartbeatTimer = null;
      // A reconnect must re-evaluate the edge route and obtain a new one-use
      // ticket. Disposing a subscription clears channel.socket before close,
      // so normal teardown cannot invalidate another subscriber's route.
      if (!routeChanged && !channel.normalClose && !handshakeStatus && !channel.failureReason && endpointContext?.route === "gateway") {
        lookup?.invalidate?.(new URL(endpoint).hostname, socket._socket?.remoteAddress);
      }
      if (!routeChanged && !channel.normalClose && !channel.failureReason) {
        this.reportEndpointOutcome({
          ...endpointContext,
          outcome: "failed",
          connectedDurationMs: openedAt ? Math.max(0, Date.now() - openedAt) : 0,
        });
      }
      if (!this.closed && channel.subscriptions.size) {
        if (channel.normalClose) {
          // The close listener resolving channel.closing runs after this one.
          queueMicrotask(() => { void this.connect(channel); });
        } else this.scheduleReconnect(channel, routeChanged ? "network_route_changed" : channel.failureReason || "websocket_closed");
      } else if (this.channels.get(channelKey(channel.marketType, channel.streamClass)) === channel) {
        this.channels.delete(channelKey(channel.marketType, channel.streamClass));
      }
    });
  }

  reportEndpointOutcome(outcome) {
    if (!this.endpointFailureReporter) return;
    try {
      Promise.resolve(this.endpointFailureReporter(outcome)).catch(() => {});
    } catch {}
  }

  subscribe({ marketType, streams } = {}, onEvent, onHealth = () => {}) {
    if (this.closed) throw new Error("TradingMarketDataHub is closed");
    if (typeof onEvent !== "function") throw new TypeError("onEvent is required");
    const normalizedStreams = [...new Set((Array.isArray(streams) ? streams : []).map(streamValue))];
    if (!normalizedStreams.length || normalizedStreams.length > 50) throw new TypeError("one to fifty Binance streams are required");
    const subscriptionId = `market-${this.nextSubscriptionId++}`;
    const channels = new Map();
    for (const stream of normalizedStreams) {
      const streamClass = streamClassValue(stream);
      const channel = channels.get(streamClass) || this.channelFor(marketType, streamClass);
      const entry = channels.get(streamClass) || { channel, streams: [] };
      entry.streams.push(stream);
      channels.set(streamClass, entry);
    }
    for (const { channel, streams: groupedStreams } of channels.values()) {
      clearTimeout(channel.idleTimer);
      channel.idleTimer = null;
      const addedStreams = [];
      const subscription = { id: subscriptionId, streams: groupedStreams, onEvent, onHealth };
      channel.subscriptions.set(subscriptionId, subscription);
      for (const stream of groupedStreams) {
        let ids = channel.streamSubscriptions.get(stream);
        if (!ids) {
          ids = new Set();
          channel.streamSubscriptions.set(stream, ids);
          addedStreams.push(stream);
        }
        ids.add(subscriptionId);
      }
      this.queueCommand(channel, "SUBSCRIBE", addedStreams);
      if (this.isOpen(channel.socket) && channel.ready && groupedStreams.every(stream => channel.acknowledgedStreams.has(stream))) onHealth(Object.freeze({ type: "health", status: "connected", at: Date.now() }));
      else void this.connect(channel);
    }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      for (const { channel, streams: groupedStreams } of channels.values()) {
        channel.subscriptions.delete(subscriptionId);
        const removedStreams = [];
        for (const stream of groupedStreams) {
          const ids = channel.streamSubscriptions.get(stream);
          ids?.delete(subscriptionId);
          if (!ids?.size) {
            channel.streamSubscriptions.delete(stream);
            removedStreams.push(stream);
          }
        }
        this.queueCommand(channel, "UNSUBSCRIBE", removedStreams);
        if (channel.subscriptions.size) continue;
        channel.idleTimer = setTimeout(() => { channel.idleTimer = null; this.retireIdleChannel(channel); }, this.idleCloseMs);
        channel.idleTimer.unref?.();
      }
    };
    return Object.freeze({ subscriptionId, dispose });
  }

  stats() {
    let subscriptions = 0;
    let streams = 0;
    let sockets = 0;
    for (const channel of this.channels.values()) {
      subscriptions += channel.subscriptions.size;
      streams += channel.streamSubscriptions.size;
      if (channel.socket) sockets += 1;
    }
    return Object.freeze({ channels: this.channels.size, subscriptions, streams, sockets });
  }

  async close() {
    if (this.closed) return this.closing;
    this.closed = true;
    const closing = [];
    for (const channel of this.channels.values()) {
      channel.generation += 1;
      clearTimeout(channel.idleTimer);
      clearTimeout(channel.reconnectTimer);
      clearTimeout(channel.handshakeTimer);
      clearInterval(channel.heartbeatTimer);
      clearTimeout(channel.commandTimer);
      channel.commandTimer = null;
      channel.pendingCommands = [];
      this.clearAcknowledgements(channel);
      channel.normalClose = true;
      closing.push(this.closeSocket(channel, 1001, "hub_shutdown"));
    }
    this.closing = Promise.all(closing).then(() => { this.channels.clear(); });
    await this.closing;
  }
}

export { marketTypeValue as normalizeTradingMarketHubType, streamValue as normalizeTradingMarketHubStream };
