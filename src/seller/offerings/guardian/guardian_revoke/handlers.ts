import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { validateGuardianRequirements } from "../guardianShared.js";

const GUARDIAN_API_URL = process.env.GUARDIAN_API_URL || "https://www.x402pulse.xyz";
const GUARDIAN_INTERNAL_TOKEN = process.env.GUARDIAN_INTERNAL_API_TOKEN || "";

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateGuardianRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  const wallet = (requirement.wallet || requirement.address || "") as string;

  console.log(`[guardian-revoke] Building revoke txs for ${wallet}`);

  try {
    // First get approvals
    const approvalsUrl = `${GUARDIAN_API_URL}/api/guardian/approvals/${wallet}`;
    const approvalsRes = await fetch(approvalsUrl, {
      headers: { "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN },
    });

    if (!approvalsRes.ok) {
      const errorText = await approvalsRes.text().catch(() => "Unknown error");
      return {
        deliverable: {
          type: "guardian_revoke_error",
          value: { success: false, error: `Approvals fetch failed: ${approvalsRes.status}`, detail: errorText, wallet },
        },
      };
    }

    const approvals = await approvalsRes.json() as { approvals?: Array<{ tokenAddress: string; spenderAddress: string; risk?: string }> };
    const riskyApprovals = (approvals.approvals || []).filter(
      (a) => a.risk === "high" || a.risk === "critical"
    );

    // Build revoke calldata via revoke endpoint
    const revokeUrl = `${GUARDIAN_API_URL}/api/guardian/revoke`;
    const revokeRes = await fetch(revokeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        tokenAddress: riskyApprovals[0]?.tokenAddress,
        spenderAddress: riskyApprovals[0]?.spenderAddress,
      }),
    });

    if (!revokeRes.ok) {
      const errorText = await revokeRes.text().catch(() => "Unknown error");
      return {
        deliverable: {
          type: "guardian_revoke_error",
          value: { success: false, error: `Revoke API failed: ${revokeRes.status}`, detail: errorText, wallet },
        },
      };
    }

    const revokeData = await revokeRes.json();

    console.log(`[guardian-revoke] Complete — ${riskyApprovals.length} risky approvals found`);

    return {
      deliverable: {
        type: "guardian_revoke_result",
        value: {
          success: true,
          wallet,
          total_approvals: (approvals.approvals || []).length,
          risky_approvals: riskyApprovals.length,
          revoke_transactions: revokeData,
        },
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[guardian-revoke] Error: ${error}`);
    return {
      deliverable: {
        type: "guardian_revoke_error",
        value: { success: false, error, wallet },
      },
    };
  }
}
