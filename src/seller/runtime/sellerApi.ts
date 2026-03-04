// =============================================================================
// Seller API calls — accept/reject, request payment, deliver.
// =============================================================================

import client from "../../lib/client.js";
import { AcpJobPhase } from "./types.js";

// -- Accept / Reject --

export interface AcceptOrRejectParams {
  accept: boolean;
  reason?: string;
}

export async function acceptOrRejectJob(
  jobId: number,
  params: AcceptOrRejectParams
): Promise<void> {
  console.log(
    `[sellerApi] acceptOrRejectJob  jobId=${jobId}  accept=${
      params.accept
    }  reason=${params.reason ?? "(none)"}`
  );

  await client.post(`/acp/providers/jobs/${jobId}/accept`, params);
}

// -- Payment request --

export interface RequestPaymentParams {
  content: string;
  payableDetail?: {
    amount: number;
    tokenAddress: string;
    recipient: string;
  };
}

export async function requestPayment(jobId: number, params: RequestPaymentParams): Promise<void> {
  await client.post(`/acp/providers/jobs/${jobId}/requirement`, params);
}

// -- Deliver --

export interface DeliverJobParams {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: {
    amount: number;
    tokenAddress: string;
  };
}

export async function deliverJob(jobId: number, params: DeliverJobParams): Promise<void> {
  const delivStr =
    typeof params.deliverable === "string"
      ? params.deliverable
      : JSON.stringify(params.deliverable);
  const transferStr = params.payableDetail
    ? `  transfer: ${params.payableDetail.amount} @ ${params.payableDetail.tokenAddress}`
    : "";
  console.log(`[sellerApi] deliverJob  jobId=${jobId}  deliverable=${delivStr}${transferStr}`);

  return await client.post(`/acp/providers/jobs/${jobId}/deliverable`, params);
}

export interface JobDeliveryState {
  phase: unknown;
  normalizedPhase: string;
  hasDeliverable: boolean;
}

export interface DeliverJobWithGuardsOptions {
  fetchState?: (jobId: number) => Promise<JobDeliveryState>;
  submitDeliverable?: (jobId: number, params: DeliverJobParams) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  backoffMs?: number;
  logger?: {
    log: (message: string) => void;
    warn: (message: string) => void;
  };
}

export type DeliverJobGuardStatus =
  | "delivered"
  | "already-delivered"
  | "already-completed"
  | "skipped-unexpected-phase";

export interface DeliverJobGuardResult {
  status: DeliverJobGuardStatus;
  phase: string;
  attempts: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 1_000;

function normalizePhase(phase: unknown): string {
  if (typeof phase === "number") {
    return AcpJobPhase[phase] ?? String(phase);
  }

  if (typeof phase === "string") {
    const trimmed = phase.trim();
    if (/^\d+$/.test(trimmed)) {
      const asNum = Number(trimmed);
      return AcpJobPhase[asNum] ?? trimmed;
    }
    return trimmed.toUpperCase();
  }

  return "UNKNOWN";
}

function hasDeliverableValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isTransactionPhase(normalizedPhase: string): boolean {
  return normalizedPhase === "TRANSACTION";
}

function isCompletedOrDeliveredPhase(normalizedPhase: string): boolean {
  return normalizedPhase === "COMPLETED" || normalizedPhase === "DELIVERED";
}

function extractErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // no-op
  }

  return raw;
}

function isTransientPhaseSyncError(err: unknown): boolean {
  const text = extractErrorText(err).toLowerCase();
  return text.includes("not in transaction phase");
}

function isAlreadyDeliveredError(err: unknown): boolean {
  const text = extractErrorText(err).toLowerCase();
  return (
    text.includes("already delivered") ||
    text.includes("deliverable already") ||
    text.includes("already has deliverable") ||
    text.includes("already submitted")
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJobPayload(responseData: unknown): Record<string, unknown> {
  if (!responseData || typeof responseData !== "object") {
    return {};
  }

  const root = responseData as Record<string, unknown>;
  const rootData = root.data;

  if (!rootData || typeof rootData !== "object") {
    return root;
  }

  const nested = rootData as Record<string, unknown>;
  const nestedData = nested.data;

  if (!nestedData || typeof nestedData !== "object") {
    return nested;
  }

  return nestedData as Record<string, unknown>;
}

export async function fetchJobDeliveryState(jobId: number): Promise<JobDeliveryState> {
  const response = await client.get(`/acp/jobs/${jobId}`);
  const payload = extractJobPayload(response.data);

  const phase = payload.phase;
  const deliverable = payload.deliverable;

  return {
    phase,
    normalizedPhase: normalizePhase(phase),
    hasDeliverable: hasDeliverableValue(deliverable),
  };
}

export async function deliverJobWithGuards(
  jobId: number,
  params: DeliverJobParams,
  options: DeliverJobWithGuardsOptions = {}
): Promise<DeliverJobGuardResult> {
  const fetchState = options.fetchState ?? fetchJobDeliveryState;
  const submitDeliverable = options.submitDeliverable ?? deliverJob;
  const sleep = options.sleep ?? sleepMs;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const logger = options.logger ?? console;

  let submitAttempts = 0;

  for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
    const state = await fetchState(jobId);

    if (state.hasDeliverable) {
      logger.log(`[sellerApi] Job ${jobId} already has deliverable — skipping duplicate delivery`);
      return {
        status: "already-delivered",
        phase: state.normalizedPhase,
        attempts: submitAttempts,
      };
    }

    if (isCompletedOrDeliveredPhase(state.normalizedPhase)) {
      logger.log(
        `[sellerApi] Job ${jobId} already in ${state.normalizedPhase} phase — treating delivery as idempotent success`
      );
      return {
        status: "already-completed",
        phase: state.normalizedPhase,
        attempts: submitAttempts,
      };
    }

    if (!isTransactionPhase(state.normalizedPhase)) {
      logger.warn(
        `[sellerApi] Job ${jobId} in unexpected phase ${state.normalizedPhase} — skipping delivery without crashing`
      );
      return {
        status: "skipped-unexpected-phase",
        phase: state.normalizedPhase,
        attempts: submitAttempts,
      };
    }

    try {
      submitAttempts += 1;
      await submitDeliverable(jobId, params);
      return {
        status: "delivered",
        phase: state.normalizedPhase,
        attempts: submitAttempts,
      };
    } catch (err) {
      if (isAlreadyDeliveredError(err)) {
        logger.log(
          `[sellerApi] Job ${jobId} deliverable already submitted by another worker — treating as success`
        );
        return {
          status: "already-delivered",
          phase: state.normalizedPhase,
          attempts: submitAttempts,
        };
      }

      const shouldRetry = isTransientPhaseSyncError(err) && retryIndex < maxRetries;
      if (!shouldRetry) {
        throw err;
      }

      logger.warn(
        `[sellerApi] Job ${jobId} delivery failed due to phase sync race; retry ${retryIndex + 1}/${maxRetries} in ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }
  }

  throw new Error(`[sellerApi] Unexpected delivery guard loop exit for job ${jobId}`);
}
