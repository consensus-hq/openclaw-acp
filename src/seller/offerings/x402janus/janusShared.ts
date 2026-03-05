import { createHmac, randomUUID } from "node:crypto";
import type { ValidationResult } from "../../runtime/offeringTypes.js";
import { validateGuardianRequirements } from "./guardianShared.js";

export const JANUS_API_URL =
  process.env.GUARDIAN_API_URL || process.env.JANUS_API_URL || "https://x402janus.com";

const INTERNAL_TOKEN =
  process.env.GUARDIAN_INTERNAL_API_TOKEN || process.env.JANUS_INTERNAL_TOKEN || "";

const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;

type JanusOperation = "approvals" | "revoke" | "revoke_batch";

interface ScanRequirement {
  wallet?: unknown;
  address?: unknown;
  walletAddress?: unknown;
}

class JanusTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Janus API request timed out after ${timeoutMs}ms`);
    this.name = "JanusTimeoutError";
  }
}

function getWalletCandidate(requirement: Record<string, unknown>): string | null {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet ?? req.address ?? req.walletAddress;

  return typeof wallet === "string" ? wallet : null;
}

function validateWallet(wallet: string): ValidationResult {
  if (!WALLET_PATTERN.test(wallet)) {
    return {
      valid: false,
      reason: "Invalid wallet address - must be 0x followed by 40 hex chars",
    };
  }

  return { valid: true };
}

function getConfiguredTimeoutMs(
  primaryEnvKey: string,
  fallbackMs: number,
  legacyEnvKey?: string
): number {
  const primaryRaw = process.env[primaryEnvKey];
  const primaryParsed = primaryRaw ? Number(primaryRaw) : NaN;

  if (Number.isFinite(primaryParsed) && primaryParsed > 0) {
    return primaryParsed;
  }

  if (legacyEnvKey) {
    const legacyRaw = process.env[legacyEnvKey];
    const legacyParsed = legacyRaw ? Number(legacyRaw) : NaN;

    if (Number.isFinite(legacyParsed) && legacyParsed > 0) {
      return legacyParsed;
    }
  }

  return fallbackMs;
}

export function getJanusTimeoutMs(operation: JanusOperation): number {
  if (operation === "approvals") {
    return getConfiguredTimeoutMs(
      "GUARDIAN_TIMEOUT_MS_APPROVALS",
      45_000,
      "JANUS_TIMEOUT_MS_APPROVALS"
    );
  }

  if (operation === "revoke") {
    return getConfiguredTimeoutMs("GUARDIAN_TIMEOUT_MS_REVOKE", 90_000, "JANUS_TIMEOUT_MS_REVOKE");
  }

  return getConfiguredTimeoutMs(
    "GUARDIAN_TIMEOUT_MS_REVOKE_BATCH",
    150_000,
    "JANUS_TIMEOUT_MS_REVOKE_BATCH"
  );
}

// ── HMAC auth (matches apps/web/src/lib/guardian/internal-auth.ts) ──────────
const HMAC_PREFIX = "guardian-internal-v1";

function createInternalAuthHeaders(secret: string): Record<string, string> {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error("[acp-seller] GUARDIAN_INTERNAL_API_TOKEN is empty — cannot sign request");
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const payload = `${HMAC_PREFIX}:${timestamp}:${nonce}`;
  const signature = createHmac("sha256", trimmed).update(payload).digest("hex");
  return {
    "x-guardian-auth-timestamp": timestamp,
    "x-nonce": nonce,
    "x-guardian-auth-signature": signature,
  };
}

export function buildJanusAuthHeaders(
  additional: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = { ...additional };

  if (INTERNAL_TOKEN) {
    Object.assign(headers, createInternalAuthHeaders(INTERNAL_TOKEN));
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
  return validateGuardianRequirements(requirement);
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
