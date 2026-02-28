import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { validateGuardianRequirements } from "../guardianShared.js";

const GUARDIAN_API_URL = process.env.GUARDIAN_API_URL || "https://www.x402pulse.xyz";
const GUARDIAN_INTERNAL_TOKEN = process.env.GUARDIAN_INTERNAL_API_TOKEN || "";

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateGuardianRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  const wallet = (requirement.wallet || requirement.address || "") as string;

  console.log(`[guardian-approvals] Fetching approvals for ${wallet}`);

  try {
    const url = `${GUARDIAN_API_URL}/api/guardian/approvals/${wallet}`;
    const res = await fetch(url, {
      headers: {
        "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN,
        "X-PAYMENT-TIER": "paid",
      },
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      return {
        deliverable: {
          type: "guardian_approvals_error",
          value: { success: false, error: `Approvals API failed: ${res.status}`, detail: errorText, wallet },
        },
      };
    }

    const data = await res.json();

    console.log(`[guardian-approvals] Complete — ${(data.approvals || []).length} approvals found`);

    return {
      deliverable: {
        type: "guardian_approvals_result",
        value: {
          success: true,
          wallet,
          ...data,
        },
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[guardian-approvals] Error: ${error}`);
    return {
      deliverable: {
        type: "guardian_approvals_error",
        value: { success: false, error, wallet },
      },
    };
  }
}
