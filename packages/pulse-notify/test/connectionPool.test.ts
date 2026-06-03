import { describe, it, expect } from "vitest";
import {
  __getConnectionPoolSizeForTests,
  __resetConnectionPoolForTests,
  acquireEventConnection,
} from "../src/connectionPool.ts";

type EventSourceMessageHandler = (message: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: EventSourceMessageHandler | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closeCount += 1;
  }
}

describe("connectionPool", () => {
  it("should share connections and handle unsubscribe correctly", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    function reset() {
      __resetConnectionPoolForTests();
      MockEventSource.instances = [];
    }

    reset();

    const firstEvents: string[] = [];
    const secondEvents: string[] = [];

    const first = acquireEventConnection(
      { serverUrl: "https://events.example.com", address: "GABC", token: "secret" },
      {
        onOpen: () => undefined,
        onEvent: (event) => firstEvents.push(event.type),
        onParseError: () => undefined,
        onError: () => undefined,
      }
    );

    const second = acquireEventConnection(
      { serverUrl: "https://events.example.com", address: "GABC", token: "secret" },
      {
        onOpen: () => undefined,
        onEvent: (event) => secondEvents.push(event.type),
        onParseError: () => undefined,
        onError: () => undefined,
      }
    );

    expect(MockEventSource.instances.length).toBe(1);
    expect(__getConnectionPoolSizeForTests()).toBe(1);

    MockEventSource.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: "payment.received" }),
    });

    expect(firstEvents).toEqual(["payment.received"]);
    expect(secondEvents).toEqual(["payment.received"]);

    first.unsubscribe();
    expect(MockEventSource.instances[0]?.closeCount).toBe(0);
    expect(__getConnectionPoolSizeForTests()).toBe(1);

    second.unsubscribe();
    expect(MockEventSource.instances[0]?.closeCount).toBe(1);
    expect(__getConnectionPoolSizeForTests()).toBe(0);
  });

  it("should separate connections by token presence", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    function reset() {
      __resetConnectionPoolForTests();
      MockEventSource.instances = [];
    }

    reset();

    const withoutToken = acquireEventConnection(
      { serverUrl: "https://events.example.com", address: "GABC" },
      {
        onOpen: () => undefined,
        onEvent: () => undefined,
        onParseError: () => undefined,
        onError: () => undefined,
      }
    );
    const withToken = acquireEventConnection(
      { serverUrl: "https://events.example.com", address: "GABC", token: "secret" },
      {
        onOpen: () => undefined,
        onEvent: () => undefined,
        onParseError: () => undefined,
        onError: () => undefined,
      }
    );

    expect(MockEventSource.instances.length).toBe(2);
    expect(__getConnectionPoolSizeForTests()).toBe(2);

    withoutToken.unsubscribe();
    withToken.unsubscribe();
    reset();
  });
});
