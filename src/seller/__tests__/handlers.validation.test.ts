import { describe, expect, it } from "vitest";
import { validateRequirements as validateQuick } from "../offerings/x402janus/x402janus_scan_quick/handlers.js";
import { validateRequirements as validateStandard } from "../offerings/x402janus/x402janus_scan_standard/handlers.js";
import { validateRequirements as validateDeep } from "../offerings/x402janus/x402janus_scan_deep/handlers.js";
import type { ValidationResult } from "../runtime/offeringTypes.js";

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function resultValid(result: ValidationResult): boolean {
  if (typeof result === "boolean") return result;
  return result.valid;
}

function resultReason(result: ValidationResult): string {
  if (typeof result === "boolean") return "";
  return result.reason ?? "";
}

const suites = [
  { tier: "quick", validate: validateQuick },
  { tier: "standard", validate: validateStandard },
  { tier: "deep", validate: validateDeep },
] as const;

describe("guardian validateRequirements handlers", () => {
  for (const { tier, validate } of suites) {
    it(`${tier}: validateRequirements handles valid/invalid/missing/extra fields`, () => {
      const validResult = validate({ wallet: VALID_WALLET });
      expect(resultValid(validResult)).toBe(true);

      const invalidResult = validate({ wallet: "0x1234" });
      expect(resultValid(invalidResult)).toBe(false);
      expect(resultReason(invalidResult)).toMatch(/Invalid wallet address/i);

      const missingResult = validate({});
      expect(resultValid(missingResult)).toBe(false);
      expect(resultReason(missingResult)).toMatch(/wallet \(or address\) is required/i);

      const extraFieldsResult = validate({
        wallet: VALID_WALLET,
        foo: "bar",
        nested: { value: 123 },
      });
      expect(resultValid(extraFieldsResult)).toBe(true);
    });
  }
});
