import assert from "node:assert/strict";
import { test } from "node:test";
import { executeJob as executeQuick } from "../offerings/x402janus/janus_scan_quick/handlers.js";
import { executeJob as executeStandard } from "../offerings/x402janus/janus_scan_standard/handlers.js";
import { executeJob as executeDeep } from "../offerings/x402janus/janus_scan_deep/handlers.js";
import type { ExecuteJobResult } from "../runtime/offeringTypes.js";

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

interface StructuredDeliverable {
  type: string;
  value: Record<string, unknown>;
}

function getDeliverable(result: ExecuteJobResult): StructuredDeliverable {
  assert.equal(typeof result.deliverable, "object");
  assert.notEqual(result.deliverable, null);
  return result.deliverable as StructuredDeliverable;
}

test("executeJob success returns structured result for quick/standard/deep", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const tier = urlString.includes("tier=deep")
      ? "deep"
      : urlString.includes("tier=quick")
        ? "quick"
        : "standard";

    return new Response(
      JSON.stringify({
        analysis: {
          overall_score: tier === "deep" ? 9.1 : tier === "standard" ? 6.4 : 4.2,
          severity: tier === "deep" ? "high" : "medium",
          confidence: 0.93,
          dimension_scores: { approvals: 7 },
          top_reasons: ["test-reason"],
          recommended_actions: ["revoke approvals"],
        },
        agentMeta: { ok: true },
        tierMeta: { tier },
      }),
      { status: 200 }
    );
  };

  const quick = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
  const standard = getDeliverable(await executeStandard({ wallet: VALID_WALLET }));
  const deep = getDeliverable(await executeDeep({ wallet: VALID_WALLET }));

  assert.equal(quick.type, "janus_scan_result");
  assert.equal(quick.value.success, true);
  assert.equal(quick.value.tier, "quick");

  assert.equal(standard.type, "janus_scan_result");
  assert.equal(standard.value.success, true);
  assert.equal(standard.value.tier, "standard");

  assert.equal(deep.type, "janus_scan_result");
  assert.equal(deep.value.success, true);
  assert.equal(deep.value.tier, "deep");

  globalThis.fetch = originalFetch;
});

test("executeJob handles API 500 errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response("upstream error", { status: 500 });

  const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
  assert.equal(result.type, "janus_scan_error");
  assert.equal(result.value.success, false);
  assert.match(String(result.value.error), /Janus API returned 500/);

  globalThis.fetch = originalFetch;
});

test("executeJob handles timeout/aborted requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("This operation was aborted");
  };

  const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
  assert.equal(result.type, "janus_scan_error");
  assert.equal(result.value.success, false);
  assert.match(String(result.value.error), /timed out/i);

  globalThis.fetch = originalFetch;
});

test("executeJob handles malformed Janus API responses", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response('"not-an-object"', { status: 200 });

  const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
  assert.equal(result.type, "janus_scan_error");
  assert.equal(result.value.success, false);
  assert.match(String(result.value.error), /Malformed Janus API response/);

  globalThis.fetch = originalFetch;
});
