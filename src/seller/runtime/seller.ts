#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
// =============================================================================

import { connectAcpSocket } from "./acpSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJobWithGuards } from "./sellerApi.js";
import { loadOffering, listOfferings, logOfferingsStatus } from "./offerings.js";
import { AcpJobPhase, type AcpJobEventData } from "./types.js";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { fileURLToPath } from "url";
import * as path from "path";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
  sanitizeAgentName,
} from "../../lib/config.js";

function setupCleanupHandlers(): void {
  const cleanup = () => {
    removePidFromConfig();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    console.error("[seller] Uncaught exception:", err);
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[seller] Unhandled rejection at:", promise, "reason:", reason);
    cleanup();
    process.exit(1);
  });
}

// -- Config --

const ACP_URL = process.env.ACP_SOCKET_URL || "https://acpx.virtuals.io";
let agentDirName: string = "";
let sellerWalletAddress: string = "";

const MAX_TRACKED_JOB_PHASES = 500;

function buildJobPhaseKey(jobId: number, phase: number): string {
  return `${jobId}:${Number(phase)}`;
}

function rememberJobPhase(processedPhases: Set<string>, jobId: number, phase: number): boolean {
  const key = buildJobPhaseKey(jobId, phase);
  if (processedPhases.has(key)) return false;

  processedPhases.add(key);

  // Bound memory: evict oldest entries.
  if (processedPhases.size > MAX_TRACKED_JOB_PHASES) {
    const oldest = processedPhases.values().next().value;
    if (oldest) processedPhases.delete(oldest);
  }

  return true;
}

type SellerLogger = Pick<typeof console, "log" | "error">;

interface SellerTaskProcessorDeps {
  loadOfferingFn?: typeof loadOffering;
  acceptOrRejectJobFn?: typeof acceptOrRejectJob;
  requestPaymentFn?: typeof requestPayment;
  deliverJobFn?: typeof deliverJob;
  getAgentDirName?: () => string;
  getSellerWalletAddress?: () => string;
  logger?: SellerLogger;
  processedJobPhases?: Set<string>;
}

export interface SellerTaskProcessor {
  enqueueJob: (data: AcpJobEventData) => void;
  waitForIdle: () => Promise<void>;
}

// -- Job handling --

function getNegotiationMemoPayload(
  data: AcpJobEventData,
  logger: SellerLogger
): Record<string, unknown> | undefined {
  try {
    logger.log(
      `[seller:memos] job=${data.id} memoToSign=${data.memoToSign} memoCount=${data.memos.length}`
    );
    data.memos.forEach((m, i) => {
      logger.log(
        `[seller:memos]   [${i}] id=${m.id} nextPhase=${m.nextPhase} content=${String(m.content).slice(0, 300)}`
      );
    });

    const negotiationMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.NEGOTIATION);
    if (!negotiationMemo) {
      logger.log(`[seller:memos] no NEGOTIATION memo found (phase=${AcpJobPhase.NEGOTIATION})`);
      return undefined;
    }

    const parsed = JSON.parse(negotiationMemo.content);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (err) {
    logger.error(`[seller:memos] parse error:`, err);
    return undefined;
  }
}

function resolveOfferingName(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;

  const candidates = [
    payload.name,
    payload.offeringName,
    payload.jobOfferingName,
    payload.offering,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function resolveServiceRequirements(
  payload: Record<string, unknown> | undefined
): Record<string, any> {
  if (!payload) return {};

  const requirementCandidates = [
    payload.requirement,
    payload.requirements,
    payload.serviceRequirements,
  ];

  for (const candidate of requirementCandidates) {
    if (typeof candidate === "object" && candidate !== null) {
      return candidate as Record<string, any>;
    }
  }

  // Fallback for payloads that inline requirement fields at root
  if ("wallet" in payload || "walletAddress" in payload || "address" in payload) {
    return payload as Record<string, any>;
  }

  return {};
}

export function createSellerTaskProcessor(deps: SellerTaskProcessorDeps = {}): SellerTaskProcessor {
  const loadOfferingFn = deps.loadOfferingFn ?? loadOffering;
  const acceptOrRejectJobFn = deps.acceptOrRejectJobFn ?? acceptOrRejectJob;
  const requestPaymentFn = deps.requestPaymentFn ?? requestPayment;
  const deliverJobFn = deps.deliverJobFn ?? deliverJob;
  const getAgentDirName = deps.getAgentDirName ?? (() => agentDirName);
  const getSellerWalletAddress = deps.getSellerWalletAddress ?? (() => sellerWalletAddress);
  const logger = deps.logger ?? console;
  const processedJobPhases = deps.processedJobPhases ?? new Set<string>();

  let jobQueue: Promise<void> = Promise.resolve();

  const isProviderJobForRuntime = (data: AcpJobEventData): boolean => {
    const sellerAddress = getSellerWalletAddress();
    if (!sellerAddress) return true;
    return data.providerAddress.toLowerCase() === sellerAddress.toLowerCase();
  };

  async function handleNewTask(data: AcpJobEventData): Promise<void> {
    const jobId = data.id;

    logger.log(`\n${"=".repeat(60)}`);
    logger.log(`[seller] New task  jobId=${jobId}  phase=${AcpJobPhase[data.phase] ?? data.phase}`);
    logger.log(`         client=${data.clientAddress}  price=${data.price}`);
    logger.log(`         context=${JSON.stringify(data.context)}`);
    logger.log(`${"=".repeat(60)}`);

    // Ignore jobs where this wallet is not the provider. Without this filter,
    // buyer-side jobs can be misprocessed by the seller runtime.
    if (!isProviderJobForRuntime(data)) {
      logger.log(
        `[seller] Skipping job ${jobId}: provider ${data.providerAddress} does not match seller ${getSellerWalletAddress()}`
      );
      return;
    }

    // Step 1: Accept / reject
    if (data.phase === AcpJobPhase.REQUEST) {
      if (!data.memoToSign) {
        return;
      }

      const negotiationMemo = data.memos.find((m) => m.id == Number(data.memoToSign));

      if (negotiationMemo?.nextPhase !== AcpJobPhase.NEGOTIATION) {
        return;
      }

      const negotiationPayload = getNegotiationMemoPayload(data, logger);
      const offeringName = resolveOfferingName(negotiationPayload);
      const requirements = resolveServiceRequirements(negotiationPayload);

      if (!offeringName) {
        await acceptOrRejectJobFn(jobId, {
          accept: false,
          reason: "Invalid offering name",
        });
        return;
      }

      try {
        const { config, handlers } = await loadOfferingFn(offeringName, getAgentDirName());

        if (handlers.validateRequirements) {
          const validationResult = handlers.validateRequirements(requirements);

          let isValid: boolean;
          let reason: string | undefined;

          if (typeof validationResult === "boolean") {
            isValid = validationResult;
            reason = isValid ? undefined : "Validation failed";
          } else {
            isValid = validationResult.valid;
            reason = validationResult.reason;
          }

          if (!isValid) {
            const rejectionReason = reason || "Validation failed";
            logger.log(
              `[seller] Validation failed for offering "${offeringName}" — rejecting: ${rejectionReason}`
            );
            await acceptOrRejectJobFn(jobId, {
              accept: false,
              reason: rejectionReason,
            });
            return;
          }
        }

        await acceptOrRejectJobFn(jobId, {
          accept: true,
          reason: "Job accepted",
        });

        const funds =
          config.requiredFunds && handlers.requestAdditionalFunds
            ? handlers.requestAdditionalFunds(requirements)
            : undefined;

        const paymentReason = handlers.requestPayment
          ? handlers.requestPayment(requirements)
          : (funds?.content ?? "Request accepted");

        await requestPaymentFn(jobId, {
          content: paymentReason,
          payableDetail: funds
            ? {
                amount: funds.amount,
                tokenAddress: funds.tokenAddress,
                recipient: funds.recipient,
              }
            : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[seller] Error processing job ${jobId}:`, err);

        // If the offering cannot be resolved locally, reject immediately so the
        // job does not remain stuck in REQUEST with no explicit provider decision.
        if (
          /offering\.json not found|handlers\.ts not found|invalid offering name/i.test(message)
        ) {
          try {
            await acceptOrRejectJobFn(jobId, {
              accept: false,
              reason: "Offering unavailable",
            });
          } catch (rejectErr) {
            logger.error(
              `[seller] Failed to reject unavailable offering for job ${jobId}:`,
              rejectErr
            );
          }
        }
      }
    }

    // Handle TRANSACTION (deliver)
    if (data.phase === AcpJobPhase.TRANSACTION) {
      const negotiationPayload = getNegotiationMemoPayload(data, logger);
      const offeringName = resolveOfferingName(negotiationPayload);
      const requirements = resolveServiceRequirements(negotiationPayload);

      if (offeringName) {
        try {
          const { handlers } = await loadOfferingFn(offeringName, getAgentDirName());
          logger.log(
            `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
          );
          const result: ExecuteJobResult = await handlers.executeJob(requirements);

          const deliveryResult = await deliverJobWithGuards(jobId, {
            deliverable: result.deliverable,
            payableDetail: result.payableDetail,
          });

          if (deliveryResult.status === 'delivered') {
            logger.log(`[seller] Job ${jobId} — delivered.`);
          } else {
            logger.log(
              `[seller] Job ${jobId} delivery skipped (${deliveryResult.status}) at phase=${deliveryResult.phase}`
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[seller] Error delivering job ${jobId}:`, err);
          // Fail closed on unknown/missing offerings — reject explicitly instead of leaving job stuck
          if (/offering\.json not found|handlers\.ts not found/i.test(message)) {
            try {
              await acceptOrRejectJobFn(jobId, { accept: false, reason: "Offering unavailable" });
            } catch (rejectErr) {
              logger.error(`[seller] Failed to reject stuck job ${jobId}:`, rejectErr);
            }
          }
        }
      } else {
        logger.log(`[seller] Job ${jobId} in TRANSACTION but no offering resolved — skipping`);
      }
      return;
    }

    logger.log(
      `[seller] Job ${jobId} in phase ${AcpJobPhase[data.phase] ?? data.phase} — no action needed`
    );
  }

  function enqueueJob(data: AcpJobEventData): void {
    const phaseLabel = AcpJobPhase[data.phase] ?? data.phase;

    // Idempotency: skip duplicate (jobId, phase) before queueing/parsing/execution.
    if (!rememberJobPhase(processedJobPhases, data.id, data.phase)) {
      logger.log(`[seller] Skipping duplicate event jobId=${data.id} phase=${phaseLabel}`);
      return;
    }

    // Process tasks serially to avoid concurrent wallet/user-op mutations.
    jobQueue = jobQueue
      .then(() => handleNewTask(data))
      .catch((err) => {
        logger.error("[seller] Unhandled error in handleNewTask:", err);
      });
  }

  return {
    enqueueJob,
    waitForIdle: () => jobQueue,
  };
}

const sellerTaskProcessor = createSellerTaskProcessor();

// -- Main --

async function main() {
  checkForExistingProcess();

  writePidToConfig(process.pid);

  setupCleanupHandlers();

  let walletAddress: string;
  try {
    const agentData = await getMyAgentInfo();
    walletAddress = agentData.walletAddress;
    sellerWalletAddress = agentData.walletAddress;
    agentDirName = sanitizeAgentName(agentData.name);
    console.log(`[seller] Agent: ${agentData.name} (dir: ${agentDirName})`);
  } catch (err) {
    console.error("[seller] Failed to resolve agent info:", err);
    process.exit(1);
  }

  const offerings = listOfferings(agentDirName);
  logOfferingsStatus(agentDirName, offerings);

  connectAcpSocket({
    acpUrl: ACP_URL,
    walletAddress,
    callbacks: {
      onNewTask: (data) => {
        sellerTaskProcessor.enqueueJob(data);
      },
      onEvaluate: (data) => {
        console.log(
          `[seller] onEvaluate received for job ${data.id} — no action (evaluation handled externally)`
        );
      },
    },
  });

  console.log("[seller] Seller runtime is running. Waiting for jobs...\n");
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error("[seller] Fatal error:", err);
    process.exit(1);
  });
}
