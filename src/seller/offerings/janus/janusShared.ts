import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";

export const JANUS_API_URL = process.env.JANUS_API_URL || "https://x402janus.com";
const JANUS_INTERNAL_TOKEN = process.env.JANUS_INTERNAL_TOKEN || "";

const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export type JanusTier = "quick" | "standard" | "deep";

interface TierSettings {
  expectedScanSeconds: number;
  defaultTimeoutMs: number;
}

const TIER_SETTINGS: Record<JanusTier, TierSettings> = {
  quick: { expectedScanSeconds: 15, defaultTimeoutMs: 45_000 },
  standard: { expectedScanSeconds: 45, defaultTimeoutMs: 90_000 },
  deep: { expectedScanSeconds: 90, defaultTimeoutMs: 150_000 },
};

interface ScanRequirement {
  wallet?: unknown;
  address?: unknown;
}

type JanusAnalysis = {
  overall_score?: unknown;
  severity?: unknown;
  confidence?: unknown;
  dimension_scores?: unknown;
  top_reasons?: unknown;
  recommended_actions?: unknown;
};

type JanusApiResponse = {
  analysis?: JanusAnalysis;
  agentMeta?: unknown;
  tierMeta?: unknown;
};

class JanusTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Janus API request timed out after ${timeoutMs}ms`);
    this.name = "JanusTimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getWalletCandidate(requirement: Record<string, unknown>): string | null {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet ?? req.address;

  return typeof wallet === "string" ? wallet : null;
}

function validateWallet(wallet: string): ValidationResult {
  if (!WALLET_PATTERN.test(wallet)) {
    return { valid: false, reason: "Invalid wallet address - must be 0x followed by 40 hex chars" };
  }

  return { valid: true };
}

function getConfiguredTimeoutMs(envKey: string, fallbackMs: number): number {
  const rawValue = process.env[envKey];
  const parsed = rawValue ? Number(rawValue) : NaN;

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallbackMs;
}

function getScanTimeoutMs(tier: JanusTier): number {
  return getConfiguredTimeoutMs(
    `JANUS_TIMEOUT_MS_${tier.toUpperCase()}`,
    TIER_SETTINGS[tier].defaultTimeoutMs
  );
}

export function getJanusTimeoutMs(operation: "approvals" | "revoke" | "revoke_batch"): number {
  if (operation === "approvals") {
    return getConfiguredTimeoutMs("JANUS_TIMEOUT_MS_APPROVALS", 45_000);
  }

  if (operation === "revoke") {
    return getConfiguredTimeoutMs("JANUS_TIMEOUT_MS_REVOKE", 60_000);
  }

  return getConfiguredTimeoutMs("JANUS_TIMEOUT_MS_REVOKE_BATCH", 90_000);
}

export function buildJanusAuthHeaders(
  additional: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = { ...additional };

  if (JANUS_INTERNAL_TOKEN) {
    headers["x-janus-internal-token"] = JANUS_INTERNAL_TOKEN;
  }

  return headers;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/abort|aborted|timeout/i.test(message)) {
      throw new JanusTimeoutError(timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function sanitizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof JanusTimeoutError) {
    return error.message;
  }

  if (error instanceof Error) {
    if (error.message.startsWith("Malformed Janus API response")) {
      return error.message;
    }

    return fallback;
  }

  return fallback;
}

export function validateJanusRequirements(requirement: Record<string, unknown>): ValidationResult {
  const wallet = getWalletCandidate(requirement);

  if (!wallet) {
    return { valid: false, reason: "wallet (or address) is required" };
  }

  return validateWallet(wallet);
}

export function getValidatedWallet(
  requirement: Record<string, unknown>
): { wallet: string } | { error: string } {
  const wallet = getWalletCandidate(requirement);

  if (!wallet) {
    return { error: "wallet (or address) is required" };
  }

  const walletValidation = validateWallet(wallet);
  if (typeof walletValidation === "boolean") {
    return walletValidation ? { wallet } : { error: "Invalid wallet address" };
  }

  if (!walletValidation.valid) {
    return { error: walletValidation.reason || "Invalid wallet address" };
  }

  return { wallet };
}

export async function executeJanusJob(
  requirement: Record<string, unknown>,
  tier: JanusTier
): Promise<ExecuteJobResult> {
  const walletResult = getValidatedWallet(requirement);
  if ("error" in walletResult) {
    return {
      deliverable: {
        type: "janus_scan_error",
        value: {
          success: false,
          error: walletResult.error,
          tier,
        },
      },
    };
  }

  const { wallet } = walletResult;
  const timeoutMs = getScanTimeoutMs(tier);
  const expectedScanSeconds = TIER_SETTINGS[tier].expectedScanSeconds;

  console.log(`[janus-scan:${tier}] Starting scan for ${wallet} (~${expectedScanSeconds}s target)`);

  try {
    const scanUrl = `${JANUS_API_URL}/api/janus/analyze?tier=${tier}`;
    console.log(`[janus-scan:${tier}] Calling ${scanUrl}`);

    const response = await fetchWithTimeout(
      scanUrl,
      {
        method: "POST",
        headers: buildJanusAuthHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          wallet,
          chainId: 8453,
          trigger: "on_demand",
        }),
      },
      timeoutMs
    );

    if (!response.ok) {
      const message = `Janus API returned ${response.status}`;
      console.error(`[janus-scan:${tier}] API error: status=${response.status}`);
      return {
        deliverable: {
          type: "janus_scan_error",
          value: {
            success: false,
            error: message,
            wallet,
            tier,
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

    const result = parsed as JanusApiResponse;

    console.log(
      `[janus-scan:${tier}] Scan complete — score: ${result.analysis?.overall_score ?? "N/A"}`
    );

    return {
      deliverable: {
        type: "janus_scan_result",
        value: {
          success: true,
          wallet,
          tier,
          expected_scan_seconds: expectedScanSeconds,
          overall_score: result.analysis?.overall_score,
          severity: result.analysis?.severity,
          confidence: result.analysis?.confidence,
          dimension_scores: result.analysis?.dimension_scores,
          top_reasons: result.analysis?.top_reasons,
          recommended_actions: result.analysis?.recommended_actions,
          agentMeta: result.agentMeta,
          tierMeta: result.tierMeta,
        },
      },
    };
  } catch (error: unknown) {
    const safeError = sanitizeErrorMessage(error, "Janus scan request failed");
    console.error(`[janus-scan:${tier}] Error: ${safeError}`);

    return {
      deliverable: {
        type: "janus_scan_error",
        value: {
          success: false,
          error: safeError,
          wallet,
          tier,
        },
      },
    };
  }
}
