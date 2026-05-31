import type { NormalizedEvent } from "@orbital/pulse-core";

type ConnectionKey = {
  serverUrl: string;
  address: string;
  token?: string;
};

export type WsTransportSubscriber = {
  onOpen: () => void;
  onEvent: (event: NormalizedEvent) => void;
  onParseError: () => void;
  onError: (message: string) => void;
};

type ConnectionEntry = {
  socket: WebSocket | null;
  subscribers: Set<WsTransportSubscriber>;
  connected: boolean;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  isClosed: boolean;
};

const pool = new Map<string, ConnectionEntry>();

const DEFAULT_INITIAL_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30000;

function getConnectionKey(key: ConnectionKey): string {
  return JSON.stringify([key.serverUrl, key.address, key.token ?? ""]);
}

function getWebSocketUrl(key: ConnectionKey): string {
  const url = new URL(key.serverUrl);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/events/${encodeURIComponent(
    key.address
  )}`;

  if (key.token) {
    url.searchParams.set("token", key.token);
  }

  return url.toString();
}

function notifySubscribers(
  entry: ConnectionEntry,
  callback: (subscriber: WsTransportSubscriber) => void
) {
  for (const subscriber of [...entry.subscribers]) {
    callback(subscriber);
  }
}

function clearRetryTimer(entry: ConnectionEntry) {
  if (entry.retryTimer !== null) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
}

function getReconnectDelayMs(attempt: number): number {
  const exponentialDelay = Math.min(
    DEFAULT_INITIAL_RECONNECT_MS * 2 ** (attempt - 1),
    DEFAULT_MAX_RECONNECT_MS
  );
  return Math.floor(Math.random() * exponentialDelay);
}

function createWebSocket(entry: ConnectionEntry, key: ConnectionKey) {
  entry.socket = new WebSocket(getWebSocketUrl(key));

  entry.socket.onopen = () => {
    clearRetryTimer(entry);
    entry.connected = true;
    entry.attempt = 0;
    notifySubscribers(entry, (subscriber) => subscriber.onOpen());
  };

  entry.socket.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as NormalizedEvent;
      notifySubscribers(entry, (subscriber) => subscriber.onEvent(event));
    } catch {
      notifySubscribers(entry, (subscriber) => subscriber.onParseError());
    }
  };

  entry.socket.onerror = () => {
    if (entry.isClosed) return;

    entry.connected = false;
    notifySubscribers(entry, (subscriber) =>
      subscriber.onError("WebSocket connection failed — retrying...")
    );
  };

  entry.socket.onclose = () => {
    if (entry.isClosed) return;

    entry.connected = false;
    scheduleReconnect(entry, key);
  };
}

function scheduleReconnect(entry: ConnectionEntry, key: ConnectionKey) {
  if (entry.retryTimer !== null || entry.isClosed) {
    return;
  }

  entry.attempt += 1;
  const delayMs = getReconnectDelayMs(entry.attempt);

  notifySubscribers(entry, (subscriber) =>
    subscriber.onError(
      `WebSocket reconnect attempt ${entry.attempt} scheduled in ${delayMs}ms.`
    )
  );

  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entry.isClosed) return;
    createWebSocket(entry, key);
  }, delayMs);
}

export function acquireWsConnection(
  key: ConnectionKey,
  subscriber: WsTransportSubscriber
) {
  const poolKey = getConnectionKey(key);
  let entry = pool.get(poolKey);

  if (!entry) {
    entry = {
      socket: null,
      subscribers: new Set(),
      connected: false,
      attempt: 0,
      retryTimer: null,
      isClosed: false,
    };

    pool.set(poolKey, entry);
    createWebSocket(entry, key);
  }

  entry.subscribers.add(subscriber);

  return {
    connected: entry.connected,
    unsubscribe: () => {
      entry?.subscribers.delete(subscriber);

      if (entry?.subscribers.size === 0) {
        entry.isClosed = true;
        clearRetryTimer(entry);
        entry.socket?.close();
        pool.delete(poolKey);
      }
    },
  };
}

export function __getWebSocketPoolSizeForTests() {
  return pool.size;
}

export function __resetWebSocketPoolForTests() {
  for (const entry of pool.values()) {
    entry.isClosed = true;
    clearRetryTimer(entry);
    entry.socket?.close();
  }

  pool.clear();
}
