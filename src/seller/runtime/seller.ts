#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
// =============================================================================

import { connectAcpSocket } from "./acpSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob } from "./sellerApi.js";
import { loadOffering, listOfferings, logOfferingsStatus } from "./offerings.js";
import { AcpJobPhase, type AcpJobEventData } from "./types.js";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
  sanitizeAgentName,
  readConfig,
} from "../../lib/config.js";

type SocketDisconnect = () => void;

interface SellerAgentInfo {
  name: string;
  walletAddress: string;
}

const ACP_URL = process.env.ACP_SOCKET_URL || "https://acpx.virtuals.io";
let agentDirName = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  if (typeof err === "string") {
    return err;
  }
  return JSON.stringify(err) || String(err);
}

function getConfiguredAgentFallback(): SellerAgentInfo | undefined {
  // Environment override (explicit and visible in production env configs)
  const envWallet = process.env.SELLER_AGENT_WALLET_ADDRESS?.trim();
  const envName = process.env.SELLER_AGENT_NAME?.trim();
  if (envWallet && envName) {
    return { name: envName, walletAddress: envWallet };
  }

  // Local config fallback (usually unavailable in Railway container by design)
  const config = readConfig();
  const active = config.agents?.find((agent) => agent.active);
  if (active?.walletAddress && active.name) {
    return { name: active.name, walletAddress: active.walletAddress };
  }

  return undefined;
}

function setupCleanupHandlers(getSocketDisconnect?: () => SocketDisconnect | undefined): void {
  let isShuttingDown = false;

  const cleanup = () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    const disconnect = getSocketDisconnect?.();
    if (disconnect) {
      disconnect();
    }

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

async function resolveSellerAgent(): Promise<{
  walletAddress: string;
  name: string;
  agentDirName: string;
}> {
  let attempt = 0;
  let delayMs = 5_000;

  while (true) {
    try {
      const agentData = await getMyAgentInfo();
      return {
        walletAddress: agentData.walletAddress,
        name: agentData.name,
        agentDirName: sanitizeAgentName(agentData.name),
      };
    } catch (err) {
      attempt += 1;

      const fallback = getConfiguredAgentFallback();
      if (fallback) {
        const fallbackDirName = sanitizeAgentName(fallback.name);
        console.warn(
          `[seller] /acp/me failed (attempt ${attempt}); falling back to local/runtime config: ${fallback.name} (dir: ${fallbackDirName})`
        );
        console.warn(
          `[seller] /acp/me failure details: ${normalizeErrorMessage(err).slice(0, 250)}`
        );

        return {
          walletAddress: fallback.walletAddress,
          name: fallback.name,
          agentDirName: fallbackDirName,
        };
      }

      const delay = Math.min(delayMs, 60_000);
      console.warn(
        `[seller] /acp/me failed (attempt ${attempt}): ${normalizeErrorMessage(err).slice(0, 250)}`
      );
      console.warn(`[seller] Retrying in ${Math.floor(delay / 1000)}s...`);
      await sleep(delay);

      delayMs *= 2;
    }
  }
}

// -- Job handling --

function resolveOfferingName(data: AcpJobEventData): string | undefined {
  try {
    const negotiationMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.NEGOTIATION);
    if (negotiationMemo) {
      return JSON.parse(negotiationMemo.content).name;
    }
  } catch {
    return undefined;
  }
}

function resolveServiceRequirements(data: AcpJobEventData): Record<string, any> {
  const negotiationMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.NEGOTIATION);
  if (negotiationMemo) {
    try {
      return JSON.parse(negotiationMemo.content).requirement;
    } catch {
      return {};
    }
  }
  return {};
}

async function handleNewTask(data: AcpJobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[seller] New task  jobId=${jobId}  phase=${AcpJobPhase[data.phase] ?? data.phase}`);
  console.log(`         client=${data.clientAddress}  price=${data.price}`);
  console.log(`         context=${JSON.stringify(data.context)}`);
  console.log(`${"=".repeat(60)}`);

  // Step 1: Accept / reject
  if (data.phase === AcpJobPhase.REQUEST) {
    if (!data.memoToSign) {
      return;
    }

    const negotiationMemo = data.memos.find((m) => m.id == Number(data.memoToSign));

    if (negotiationMemo?.nextPhase !== AcpJobPhase.NEGOTIATION) {
      return;
    }

    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (!offeringName) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: "Invalid offering name",
      });
      return;
    }

    try {
      const { config, handlers } = await loadOffering(offeringName, agentDirName);

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
          console.log(
            `[seller] Validation failed for offering "${offeringName}" — rejecting: ${rejectionReason}`
          );
          await acceptOrRejectJob(jobId, {
            accept: false,
            reason: rejectionReason,
          });
          return;
        }
      }

      await acceptOrRejectJob(jobId, {
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

      await requestPayment(jobId, {
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
      console.error(`[seller] Error processing job ${jobId}:`, err);
    }
  }

  // Handle TRANSACTION (deliver)
  if (data.phase === AcpJobPhase.TRANSACTION) {
    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (offeringName) {
      try {
        const { handlers } = await loadOffering(offeringName, agentDirName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );
        const result: ExecuteJobResult = await handlers.executeJob(requirements);

        await deliverJob(jobId, {
          deliverable: result.deliverable,
          payableDetail: result.payableDetail,
        });
        console.log(`[seller] Job ${jobId} — delivered.`);
      } catch (err) {
        console.error(`[seller] Error delivering job ${jobId}:`, err);
      }
    } else {
      console.log(`[seller] Job ${jobId} in TRANSACTION but no offering resolved — skipping`);
    }
    return;
  }

  console.log(
    `[seller] Job ${jobId} in phase ${AcpJobPhase[data.phase] ?? data.phase} — no action needed`
  );
}

// -- Main --

async function main() {
  checkForExistingProcess();
  writePidToConfig(process.pid);

  let socketDisconnect: SocketDisconnect | undefined;

  setupCleanupHandlers(() => socketDisconnect);

  const sellerAgent = await resolveSellerAgent();
  const walletAddress = sellerAgent.walletAddress;
  agentDirName = sellerAgent.agentDirName;
  console.log(`[seller] Agent: ${sellerAgent.name} (dir: ${agentDirName})`);

  const offerings = listOfferings(agentDirName);
  logOfferingsStatus(agentDirName, offerings);

  socketDisconnect = connectAcpSocket({
    acpUrl: ACP_URL,
    walletAddress,
    callbacks: {
      onNewTask: (data) => {
        handleNewTask(data).catch((err) =>
          console.error("[seller] Unhandled error in handleNewTask:", err)
        );
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

main().catch((err) => {
  console.error("[seller] Fatal error:", err);
  process.exitCode = 1;
});
