import { useState, useEffect } from "react";
import type { NormalizedEvent } from "@orbital/pulse-core";
import { acquireEventConnection } from "./connectionPool.js";

export type UseEventConfig = {
  serverUrl: string;
  address: string;
  event?: string | string[]; // "*" = all events; array = allowlist of types
  /** API key forwarded as ?token= query param — required when the server has authentication enabled */
  token?: string;
};

export type EventState<T extends NormalizedEvent = NormalizedEvent> = {
  event: T | null;
  connected: boolean;
  error: string | null;
  lastEventAt: string | null;
};

export function useStellarEvent<T extends NormalizedEvent = NormalizedEvent>(
  config: UseEventConfig
): EventState<T>;
export function useStellarEvent<T extends NormalizedEvent = NormalizedEvent>(
  serverUrl: string,
  address: string,
  options?: Pick<UseEventConfig, "event" | "token">
): EventState<T>;
export function useStellarEvent<T extends NormalizedEvent = NormalizedEvent>(
  configOrUrl: UseEventConfig | string,
  address?: string,
  options?: Pick<UseEventConfig, "event" | "token">
): EventState<T> {
  // Normalise the two call signatures down to four primitives.
  const serverUrl =
    typeof configOrUrl === "string" ? configOrUrl : configOrUrl.serverUrl;
  const addr =
    typeof configOrUrl === "string" ? address! : configOrUrl.address;
  const eventType: string | string[] =
    typeof configOrUrl === "string"
      ? options?.event ?? "*"
      : configOrUrl.event ?? "*";
  const token =
    typeof configOrUrl === "string"
      ? options?.token
      : configOrUrl.token;

  // Serialise eventType to a stable string for the dep array.
  // An array literal passed by the caller would otherwise be a new reference
  // every render and re-run the effect continuously.
  const eventKey = Array.isArray(eventType)
    ? [...eventType].sort().join(",")
    : eventType;

  const [state, setState] = useState<EventState<T>>({
    event: null,
    connected: false,
    error: null,
    lastEventAt: null,
  });

  useEffect(() => {
    const connection = acquireEventConnection(
      { serverUrl, address: addr, token },
      {
        onOpen: () => {
          setState((prev) => ({ ...prev, connected: true, error: null }));
        },
        onEvent: (incoming) => {
          // Filter by event type: pass if "*", if type matches the string,
          // or if type is included in the allowlist array.
          const allowed =
            eventType === "*" ||
            (Array.isArray(eventType)
              ? eventType.includes(incoming.type)
              : incoming.type === eventType);

          if (!allowed) return;

          setState((prev) => ({
            ...prev,
            event: incoming as T,
            lastEventAt: incoming.timestamp ?? null,
          }));
        },
        onParseError: () => {
          setState((prev) => ({ ...prev, error: "Failed to parse event" }));
        },
        onError: () => {
          setState((prev) => ({
            ...prev,
            connected: false,
            error: "Connection lost — retrying...",
          }));
        },
      }
    );

    if (connection.connected) {
      setState((prev) => ({ ...prev, connected: true, error: null }));
    }

    return () => {
      connection.unsubscribe();
    };
    // ✅ eventKey is a serialised string — stable even when the caller passes
    // an array literal, which would otherwise be a new reference every render.
  }, [serverUrl, addr, eventKey, token]);

  return state;
}

export function useStellarPayment(serverUrl: string, address: string) {
  return useStellarEvent<Extract<NormalizedEvent, { type: "payment.received" }>>(
    serverUrl,
    address,
    { event: "payment.received" }
  );
}

export type UseActivityConfig = Pick<UseEventConfig, "token">;
export type UseHistoryConfig = UseActivityConfig & {
  /** Maximum number of events to retain in FIFO order. Defaults to 100. */
  capacity?: number;
};

export type HistoryState<T extends NormalizedEvent = NormalizedEvent> =
  EventState<T> & {
    history: T[];
  };

export function useStellarActivity<
  T extends NormalizedEvent = NormalizedEvent
>(
  serverUrl: string,
  address: string,
  options?: UseActivityConfig
): EventState<T> {
  return useStellarEvent<T>(serverUrl, address, {
    event: "*",
    token: options?.token,
  });
}

export function useStellarHistory<
  T extends NormalizedEvent = NormalizedEvent
>(
  serverUrl: string,
  address: string,
  options?: UseHistoryConfig
): HistoryState<T> {
  const { event, connected, error, lastEventAt } = useStellarActivity<T>(
    serverUrl,
    address,
    {
      token: options?.token,
    }
  );

  const [history, setHistory] = useState<T[]>([]);
  const capacity = Math.max(0, options?.capacity ?? 100);

  useEffect(() => {
    if (!event) return;

    setHistory((prev) => {
      const next = [...prev, event];
      return next.length > capacity ? next.slice(next.length - capacity) : next;
    });
  }, [event, capacity]);

  useEffect(() => {
    if (capacity === 0) {
      setHistory([]);
      return;
    }

    setHistory((prev) =>
      prev.length > capacity ? prev.slice(-capacity) : prev
    );
  }, [capacity]);

  return { history, event, connected, error, lastEventAt };
}
