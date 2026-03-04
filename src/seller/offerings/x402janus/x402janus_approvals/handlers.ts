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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateJanusRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  const walletResult = getValidatedWallet(requirement);
  if ("error" in walletResult) {
    return {
      deliverable: {
        type: "janus_approvals_error",
        value: { success: false, error: walletResult.error },
      },
    };
  }

  const { wallet } = walletResult;
  const timeoutMs = getJanusTimeoutMs("approvals");

  console.log(`[janus-approvals] Fetching approvals for ${wallet}`);

  try {
    const url = `${JANUS_API_URL}/api/janus/approvals/${wallet}`;
    const response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: buildJanusAuthHeaders(),
      },
      timeoutMs
    );

    if (!response.ok) {
      const message = `Janus approvals API returned ${response.status}`;
      console.error(`[janus-approvals] API error: status=${response.status}`);
      return {
        deliverable: {
          type: "janus_approvals_error",
          value: {
            success: false,
            error: message,
            wallet,
            status: response.status,
          },
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("Malformed Janus API response: invalid JSON body");
    }

    if (!isRecord(parsed)) {
      throw new Error("Malformed Janus API response: expected JSON object");
    }

    const approvals = parsed.approvals;
    const approvalCount = Array.isArray(approvals) ? approvals.length : 0;

    console.log(`[janus-approvals] Complete — ${approvalCount} approvals found`);

    return {
      deliverable: {
        type: "janus_approvals_result",
        value: {
          success: true,
          wallet,
          ...parsed,
        },
      },
    };
  } catch (error: unknown) {
    const safeError = sanitizeErrorMessage(error, "Janus approvals request failed");
    console.error(`[janus-approvals] Error: ${safeError}`);

    return {
      deliverable: {
        type: "janus_approvals_error",
        value: { success: false, error: safeError, wallet },
      },
    };
  }
}
