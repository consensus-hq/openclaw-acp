import { describe, expect, it } from "vitest";
import { connectAcpSocket, type SocketLike } from "../runtime/acpSocket.js";

class FakeSocket implements SocketLike {
  public connected = false;
  public connectCalls = 0;
  public disconnectCalls = 0;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, handler: (...args: any[]) => void): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  connect(): void {
    this.connectCalls += 1;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("connectAcpSocket", () => {
  it("socket reconnect loop + PagerDuty trigger/resolve flow", async () => {
    const previousPdKey = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = "pd_test_key";

    const socket = new FakeSocket();
    const pdEvents: any[] = [];
    let disconnect: (() => void) | undefined;

    try {
      disconnect = connectAcpSocket(
        {
          acpUrl: "https://acp.example",
          walletAddress: "0x1111111111111111111111111111111111111111",
          callbacks: {
            onNewTask: () => undefined,
          },
        },
        {
          createSocket: () => socket,
          fetchFn: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            pdEvents.push(body);
            return new Response(JSON.stringify({ status: "success" }), { status: 202 });
          },
          manualReconnectIntervalMs: 20,
          failedReconnectsBeforeAlert: 3,
          heartbeatIntervalMs: 60_000,
          disconnectMonitorIntervalMs: 60_000,
          disconnectAlertThresholdMs: 300_000,
        }
      );

      socket.emit("disconnect", "io server disconnect");

      await sleep(90);
      expect(socket.connectCalls).toBeGreaterThanOrEqual(3);

      const triggerCount = pdEvents.filter((event) => event.event_action === "trigger").length;
      expect(triggerCount).toBe(1);

      socket.connected = true;
      socket.emit("connect");

      await sleep(20);
      const resolveCount = pdEvents.filter((event) => event.event_action === "resolve").length;
      expect(resolveCount).toBe(1);
    } finally {
      disconnect?.();
      process.env.PAGERDUTY_ROUTING_KEY = previousPdKey;
    }
  });

  it("socket disconnect > threshold triggers PagerDuty", async () => {
    const previousPdKey = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = "pd_test_key";

    const socket = new FakeSocket();
    const pdEvents: any[] = [];
    let nowMs = 0;
    let disconnect: (() => void) | undefined;

    try {
      disconnect = connectAcpSocket(
        {
          acpUrl: "https://acp.example",
          walletAddress: "0x2222222222222222222222222222222222222222",
          callbacks: {
            onNewTask: () => undefined,
          },
        },
        {
          createSocket: () => socket,
          fetchFn: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            pdEvents.push(body);
            return new Response(JSON.stringify({ status: "success" }), { status: 202 });
          },
          nowFn: () => nowMs,
          manualReconnectIntervalMs: 1_000,
          failedReconnectsBeforeAlert: 99,
          heartbeatIntervalMs: 60_000,
          disconnectMonitorIntervalMs: 10,
          disconnectAlertThresholdMs: 120_000,
        }
      );

      socket.emit("disconnect", "transport close");
      nowMs = 121_000;

      await sleep(40);

      const triggerCount = pdEvents.filter((event) => event.event_action === "trigger").length;
      expect(triggerCount).toBe(1);
    } finally {
      disconnect?.();
      process.env.PAGERDUTY_ROUTING_KEY = previousPdKey;
    }
  });
});
