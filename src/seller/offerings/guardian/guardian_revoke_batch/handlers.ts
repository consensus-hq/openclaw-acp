import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { validateGuardianRequirements } from "../guardianShared.js";

const GUARDIAN_API_URL = process.env.GUARDIAN_API_URL || "https://www.x402pulse.xyz";
const GUARDIAN_INTERNAL_TOKEN = process.env.GUARDIAN_INTERNAL_API_TOKEN || "";

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateGuardianRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  const wallet = (requirement.wallet || requirement.address || "") as string;

  console.log(`[guardian-revoke-batch] Building batch revoke txs for ${wallet}`);

  try {
    // Get all approvals
    const approvalsUrl = `${GUARDIAN_API_URL}/api/guardian/approvals/${wallet}`;
    const approvalsRes = await fetch(approvalsUrl, {
      headers: { "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN },
    });

    if (!approvalsRes.ok) {
      const errorText = await approvalsRes.text().catch(() => "Unknown error");
      return {
        deliverable: {
          type: "guardian_revoke_batch_error",
          value: { success: false, error: `Approvals fetch failed: ${approvalsRes.status}`, detail: errorText, wallet },
        },
      };
    }

    const approvals = await approvalsRes.json() as { approvals?: Array<{ tokenAddress: string; spenderAddress: string; risk?: string }> };
    const riskyApprovals = (approvals.approvals || []).filter(
      (a) => a.risk === "high" || a.risk === "critical" || a.risk === "medium"
    );

    if (riskyApprovals.length === 0) {
      return {
        deliverable: {
          type: "guardian_revoke_batch_result",
          value: {
            success: true,
            wallet,
            total_approvals: (approvals.approvals || []).length,
            risky_approvals: 0,
            message: "No risky approvals found — wallet is clean",
            revoke_transactions: [],
          },
        },
      };
    }

    // Batch revoke via paid endpoint
    const revokeUrl = `${GUARDIAN_API_URL}/api/guardian/revoke`;
    const revokeRes = await fetch(revokeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN,
        "X-PAYMENT-TIER": "paid",
      },
      body: JSON.stringify({
        revocations: riskyApprovals.map((a) => ({
          tokenAddress: a.tokenAddress,
          spenderAddress: a.spenderAddress,
        })),
      }),
    });

    if (!revokeRes.ok) {
      const errorText = await revokeRes.text().catch(() => "Unknown error");
      return {
        deliverable: {
          type: "guardian_revoke_batch_error",
          value: { success: false, error: `Batch revoke API failed: ${revokeRes.status}`, detail: errorText, wallet },
        },
      };
    }

    const revokeData = await revokeRes.json();

    console.log(`[guardian-revoke-batch] Complete — ${riskyApprovals.length} revoke txs built`);

    return {
      deliverable: {
        type: "guardian_revoke_batch_result",
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
    console.error(`[guardian-revoke-batch] Error: ${error}`);
    return {
      deliverable: {
        type: "guardian_revoke_batch_error",
        value: { success: false, error, wallet },
      },
    };
  }
}
