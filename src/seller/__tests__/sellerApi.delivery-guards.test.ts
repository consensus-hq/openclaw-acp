import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverJobWithGuards,
  type DeliverJobParams,
  type JobDeliveryState,
} from "../runtime/sellerApi.js";

const baseParams: DeliverJobParams = {
  deliverable: "scan complete",
};

function makeLogger() {
  const logs: string[] = [];
  const warnings: string[] = [];

  return {
    logs,
    warnings,
    logger: {
      log: (message: string) => logs.push(message),
      warn: (message: string) => warnings.push(message),
    },
  };
}

test("delivery when job is already COMPLETED succeeds silently", async () => {
  const { logger, warnings } = makeLogger();
  let submitCalls = 0;

  const result = await deliverJobWithGuards(1001, baseParams, {
    fetchState: async (): Promise<JobDeliveryState> => ({
      phase: "COMPLETED",
      normalizedPhase: "COMPLETED",
      hasDeliverable: false,
    }),
    submitDeliverable: async () => {
      submitCalls += 1;
    },
    logger,
  });

  assert.equal(result.status, "already-completed");
  assert.equal(submitCalls, 0);
  assert.equal(warnings.length, 0);
});

test("delivery when job is in REQUEST fails gracefully", async () => {
  const { logger, warnings } = makeLogger();
  let submitCalls = 0;

  const result = await deliverJobWithGuards(1002, baseParams, {
    fetchState: async (): Promise<JobDeliveryState> => ({
      phase: "REQUEST",
      normalizedPhase: "REQUEST",
      hasDeliverable: false,
    }),
    submitDeliverable: async () => {
      submitCalls += 1;
    },
    logger,
  });

  assert.equal(result.status, "skipped-unexpected-phase");
  assert.equal(submitCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unexpected phase request/i);
});

test("transient phase sync delay retries and eventually succeeds", async () => {
  const { logger } = makeLogger();
  let submitCalls = 0;
  const sleepCalls: number[] = [];

  const result = await deliverJobWithGuards(1003, baseParams, {
    fetchState: async (): Promise<JobDeliveryState> => ({
      phase: "TRANSACTION",
      normalizedPhase: "TRANSACTION",
      hasDeliverable: false,
    }),
    submitDeliverable: async () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        throw new Error(
          JSON.stringify({
            statusCode: 500,
            message: "Failed to process job deliverable: Job is not in transaction phase",
          })
        );
      }
    },
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    logger,
  });

  assert.equal(result.status, "delivered");
  assert.equal(result.attempts, 2);
  assert.equal(submitCalls, 2);
  assert.deepEqual(sleepCalls, [1000]);
});

test("retry path never double-delivers when deliverable already exists", async () => {
  const { logger } = makeLogger();
  let submitCalls = 0;
  let fetchCalls = 0;

  const result = await deliverJobWithGuards(1004, baseParams, {
    fetchState: async (): Promise<JobDeliveryState> => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return {
          phase: "TRANSACTION",
          normalizedPhase: "TRANSACTION",
          hasDeliverable: false,
        };
      }

      return {
        phase: "COMPLETED",
        normalizedPhase: "COMPLETED",
        hasDeliverable: true,
      };
    },
    submitDeliverable: async () => {
      submitCalls += 1;
      throw new Error(
        JSON.stringify({
          statusCode: 500,
          message: "Failed to process job deliverable: Job is not in transaction phase",
        })
      );
    },
    sleep: async () => {
      // no-op
    },
    logger,
  });

  assert.equal(result.status, "already-delivered");
  assert.equal(submitCalls, 1);
  assert.equal(fetchCalls, 2);
});
