import { describe, expect, it } from "vitest";
import { executeJob as executeQuick } from "../offerings/guardian/guardian_scan_quick/handlers.js";
import { executeJob as executeStandard } from "../offerings/guardian/guardian_scan_standard/handlers.js";
import { executeJob as executeDeep } from "../offerings/guardian/guardian_scan_deep/handlers.js";
import type { ExecuteJobResult } from "../runtime/offeringTypes.js";

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function getDeliverable(result: ExecuteJobResult): { type: string; value: any } {
  expect(result.deliverable).toBeTypeOf("object");
  return result.deliverable as { type: string; value: any };
}

describe("guardian executeJob handlers", () => {
  it("executeJob success returns structured result for quick/standard/deep", async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async (url, init) => {
        const urlString = String(url);
        const tier = urlString.includes("tier=deep")
          ? "deep"
          : urlString.includes("tier=quick")
            ? "quick"
            : "standard";

        const body = JSON.parse(String(init?.body ?? "{}"));
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
            echoedWallet: body.wallet,
          }),
          { status: 200 }
        );
      };

      const quick = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
      const standard = getDeliverable(await executeStandard({ wallet: VALID_WALLET }));
      const deep = getDeliverable(await executeDeep({ wallet: VALID_WALLET }));

      expect(quick.type).toBe("guardian_scan_result");
      expect(quick.value.success).toBe(true);
      expect(quick.value.tier).toBe("quick");

      expect(standard.type).toBe("guardian_scan_result");
      expect(standard.value.success).toBe(true);
      expect(standard.value.tier).toBe("standard");

      expect(deep.type).toBe("guardian_scan_result");
      expect(deep.value.success).toBe(true);
      expect(deep.value.tier).toBe("deep");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executeJob handles API 500 errors", async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async () => new Response("upstream error", { status: 500 });

      const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
      expect(result.type).toBe("guardian_scan_error");
      expect(result.value.success).toBe(false);
      expect(result.value.error).toMatch(/Guardian API returned 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executeJob handles timeout/aborted requests", async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async () => {
        throw new Error("This operation was aborted");
      };

      const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
      expect(result.type).toBe("guardian_scan_error");
      expect(result.value.success).toBe(false);
      expect(result.value.error).toMatch(/timed out/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executeJob handles malformed Guardian API responses", async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async () => new Response('"not-an-object"', { status: 200 });

      const result = getDeliverable(await executeQuick({ wallet: VALID_WALLET }));
      expect(result.type).toBe("guardian_scan_error");
      expect(result.value.success).toBe(false);
      expect(result.value.error).toMatch(/Malformed Guardian API response/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
