import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import {
  JANUS_API_URL,
  buildJanusAuthHeaders,
  fetchWithTimeout,
  getJanusTimeoutMs,
  getValidatedWallet,
  sanitizeErrorMessage,
  validateJanusRequirements,
} from "../janusShared.js";

interface RiskyApproval {
  tokenAddress: string;
  spenderAddress: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRiskyApprovals(payload: unknown): RiskyApproval[] {
  if (!isRecord(payload)) {
    return [];
  }

  const approvals = payload.approvals;
  if (!Array.isArray(approvals)) {
    return [];
  }

  return approvals
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => {
      const tokenAddress = typeof entry.tokenAddress === "string" ? entry.tokenAddress : "";
      const spenderAddress = typeof entry.spenderAddress === "string" ? entry.spenderAddress : "";
      const risk = typeof entry.risk === "string" ? entry.risk.toLowerCase() : "";

      return {
        tokenAddress,
        spenderAddress,
        risk,
      };
    })
    .filter(
      (entry): entry is RiskyApproval & { risk: string } =>
        entry.tokenAddress.length > 0 &&
        entry.spenderAddress.length > 0 &&
        (entry.risk === "medium" || entry.risk === "high" || entry.risk === "critical")
    )
    .map(({ tokenAddress, spenderAddress }) => ({ tokenAddress, spenderAddress }));
}

function getTotalApprovals(payload: unknown): number {
  if (!isRecord(payload)) {
    return 0;
  }

  return Array.isArray(payload.approvals) ? payload.approvals.length : 0;
}

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateJanusRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  const walletResult = getValidatedWallet(requirement);
  if ("error" in walletResult) {
    return {
      deliverable: {
        type: "janus_revoke_batch_error",
        value: { success: false, error: walletResult.error },
      },
    };
  }

  const { wallet } = walletResult;
  const approvalsTimeoutMs = getJanusTimeoutMs("approvals");
  const revokeTimeoutMs = getJanusTimeoutMs("revoke_batch");

  console.log(`[janus-revoke-batch] Building batch revoke txs for ${wallet}`);

  try {
    const approvalsUrl = `${JANUS_API_URL}/api/janus/approvals/${wallet}`;
    const approvalsResponse = await fetchWithTimeout(
      approvalsUrl,
      {
        method: "GET",
        headers: buildJanusAuthHeaders(),
      },
      approvalsTimeoutMs
    );

    if (!approvalsResponse.ok) {
      const message = `Janus approvals API returned ${approvalsResponse.status}`;
      console.error(`[janus-revoke-batch] Approvals API error: status=${approvalsResponse.status}`);
      return {
        deliverable: {
          type: "janus_revoke_batch_error",
          value: {
            success: false,
            error: message,
            wallet,
            status: approvalsResponse.status,
          },
        },
      };
    }

    let approvalsPayload: unknown;
    try {
      approvalsPayload = await approvalsResponse.json();
    } catch {
      throw new Error("Malformed Janus API response: invalid approvals JSON body");
    }

    const riskyApprovals = parseRiskyApprovals(approvalsPayload);
    const totalApprovals = getTotalApprovals(approvalsPayload);

    if (riskyApprovals.length === 0) {
      return {
        deliverable: {
          type: "janus_revoke_batch_result",
          value: {
            success: true,
            wallet,
            total_approvals: totalApprovals,
            risky_approvals: 0,
            message: "No risky approvals found — wallet is clean",
            revoke_transactions: [],
          },
        },
      };
    }

    const revokeUrl = `${JANUS_API_URL}/api/janus/revoke`;
    const revokeResponse = await fetchWithTimeout(
      revokeUrl,
      {
        method: "POST",
        headers: buildJanusAuthHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          revocations: riskyApprovals.map((approval) => ({
            tokenAddress: approval.tokenAddress,
            spenderAddress: approval.spenderAddress,
          })),
        }),
      },
      revokeTimeoutMs
    );

    if (!revokeResponse.ok) {
      const message = `Janus revoke API returned ${revokeResponse.status}`;
      console.error(`[janus-revoke-batch] Revoke API error: status=${revokeResponse.status}`);
      return {
        deliverable: {
          type: "janus_revoke_batch_error",
          value: {
            success: false,
            error: message,
            wallet,
            status: revokeResponse.status,
          },
        },
      };
    }

    let revokePayload: unknown;
    try {
      revokePayload = await revokeResponse.json();
    } catch {
      throw new Error("Malformed Janus API response: invalid revoke JSON body");
    }

    console.log(`[janus-revoke-batch] Complete — ${riskyApprovals.length} revoke txs built`);

    return {
      deliverable: {
        type: "janus_revoke_batch_result",
        value: {
          success: true,
          wallet,
          total_approvals: totalApprovals,
          risky_approvals: riskyApprovals.length,
          revoke_transactions: revokePayload,
        },
      },
    };
  } catch (error: unknown) {
    const safeError = sanitizeErrorMessage(error, "Janus batch revoke request failed");
    console.error(`[janus-revoke-batch] Error: ${safeError}`);

    return {
      deliverable: {
        type: "janus_revoke_batch_error",
        value: { success: false, error: safeError, wallet },
      },
    };
  }
}
