import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectAcpSocket, type SocketLike } from "../runtime/acpSocket.js";
import { createSellerTaskProcessor } from "../runtime/seller.js";
import { AcpJobPhase, MemoType, SocketEvent, type AcpJobEventData } from "../runtime/types.js";

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
    this.connected = true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

function buildEvent(jobId: number, phase: AcpJobPhase): AcpJobEventData {
  const negotiationPayload = {
    offeringName: "x402janus_scan_quick",
    requirements: {
      wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    },
  };

  return {
    id: jobId,
    phase,
    clientAddress: "0xclient",
    providerAddress: "0xprovider",
    evaluatorAddress: "0xevaluator",
    price: 1,
    context: {},
    memoToSign: phase === AcpJobPhase.REQUEST ? 5001 : undefined,
    memos: [
      {
        id: 5001,
        memoType: MemoType.MESSAGE,
        content: JSON.stringify(negotiationPayload),
        nextPhase: AcpJobPhase.NEGOTIATION,
      },
    ],
  };
}

function createProcessorHarness() {
  const calls = {
    accept: 0,
    requestPayment: 0,
    execute: 0,
    deliver: 0,
    loadOffering: 0,
  };

  const processor = createSellerTaskProcessor({
    loadOfferingFn: async () => {
      calls.loadOffering += 1;
      return {
        config: {
          name: "x402janus_scan_quick",
          description: "test",
          jobFee: 1,
          jobFeeType: "fixed",
          requiredFunds: false,
        },
        handlers: {
          executeJob: async () => {
            calls.execute += 1;
            return {
              deliverable: {
                type: "test-result",
                value: { ok: true },
              },
            };
          },
          requestPayment: () => "Request accepted",
        },
      };
    },
    acceptOrRejectJobFn: async () => {
      calls.accept += 1;
    },
    requestPaymentFn: async () => {
      calls.requestPayment += 1;
    },
    deliverJobFn: async () => {
      calls.deliver += 1;
    },
    getAgentDirName: () => "x402janus",
    getSellerWalletAddress: () => "0xprovider",
    logger: {
      log: () => undefined,
      error: () => undefined,
    },
  });

  return { processor, calls };
}

function connectHarnessSocket(
  socket: FakeSocket,
  processor: ReturnType<typeof createSellerTaskProcessor>
) {
  return connectAcpSocket(
    {
      acpUrl: "https://acp.example",
      walletAddress: "0xprovider",
      callbacks: {
        onNewTask: (data) => processor.enqueueJob(data),
      },
    },
    {
      createSocket: () => socket,
      heartbeatIntervalMs: 60_000,
      disconnectMonitorIntervalMs: 60_000,
    }
  );
}

describe("seller runtime memo/event dedupe", () => {
  it("simulated duplicate socket events (same jobId+phase) are processed once", async () => {
    const socket = new FakeSocket();
    const { processor, calls } = createProcessorHarness();
    const disconnectSocket = connectHarnessSocket(socket, processor);

    try {
      const requestEvent = buildEvent(1001, AcpJobPhase.REQUEST);

      socket.emit(SocketEvent.ON_NEW_TASK, requestEvent, () => undefined);
      socket.emit(SocketEvent.ON_NEW_TASK, requestEvent, () => undefined);

      await processor.waitForIdle();

      assert.equal(calls.accept, 1, "REQUEST phase should be accepted exactly once");
      assert.equal(calls.requestPayment, 1, "REQUEST payment should be requested exactly once");
    } finally {
      disconnectSocket();
    }
  });

  it("REQUEST and TRANSACTION are each handled exactly once per job+phase", async () => {
    const { processor, calls } = createProcessorHarness();

    const requestEvent = buildEvent(2002, AcpJobPhase.REQUEST);
    const txEvent = buildEvent(2002, AcpJobPhase.TRANSACTION);

    processor.enqueueJob(requestEvent);
    processor.enqueueJob(requestEvent);
    processor.enqueueJob(txEvent);
    processor.enqueueJob(txEvent);

    await processor.waitForIdle();

    assert.equal(calls.accept, 1, "REQUEST phase should be accepted exactly once");
    assert.equal(calls.requestPayment, 1, "REQUEST payment should be requested exactly once");
    assert.equal(calls.execute, 1, "TRANSACTION executeJob should run exactly once");
    assert.equal(calls.deliver, 1, "TRANSACTION deliverJob should run exactly once");
  });

  it("reconnect replay does not re-execute the same TRANSACTION job phase", async () => {
    const socket = new FakeSocket();
    const { processor, calls } = createProcessorHarness();
    const disconnectSocket = connectHarnessSocket(socket, processor);

    try {
      const txEvent = buildEvent(3001, AcpJobPhase.TRANSACTION);

      socket.emit(SocketEvent.ON_NEW_TASK, txEvent, () => undefined);
      socket.emit("disconnect", "io server disconnect");
      socket.emit("connect");
      socket.emit(SocketEvent.ON_NEW_TASK, txEvent, () => undefined);

      await processor.waitForIdle();

      assert.equal(calls.execute, 1, "executeJob must run once even after reconnect replay");
      assert.equal(calls.deliver, 1, "deliverJob must run once even after reconnect replay");
    } finally {
      disconnectSocket();
    }
  });
});
