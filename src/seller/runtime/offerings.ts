// =============================================================================
// Dynamic loader for seller offerings.
// Offerings are stored per-agent: src/seller/offerings/<agent-name>/<offering>/
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getCanonicalCatalog, type CanonicalOffering } from "../offerings/canonical-catalog.js";
import type { OfferingHandlers } from "./offeringTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The parsed offering.json config. */

export interface OfferingConfig {
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  requiredFunds: boolean;
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: OfferingHandlers;
}

export interface CanonicalCatalogValidationIssue {
  type:
    | "missing_offering"
    | "extra_offering"
    | "missing_offering_json"
    | "invalid_offering_json"
    | "invalid_job_fee"
    | "price_mismatch";
  message: string;
  offeringName?: string;
}

export interface CanonicalCatalogValidationResult {
  ok: boolean;
  catalog: readonly CanonicalOffering[];
  discoveredOfferings: string[];
  issues: CanonicalCatalogValidationIssue[];
}

function resolveOfferingsRoot(agentDirName: string): string {
  return path.resolve(__dirname, "..", "offerings", agentDirName);
}

function resolveOfferingJsonPath(agentDirName: string, offeringName: string): string {
  return path.resolve(resolveOfferingsRoot(agentDirName), offeringName, "offering.json");
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function parseOfferingConfig(configPath: string): OfferingConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OfferingConfig;
}

function hasMatchingPrice(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) < 1e-9;
}

/**
 * Load a named offering from `src/seller/offerings/<agentDirName>/<name>/`.
 * Expects `offering.json` and `handlers.ts` in that directory.
 */
export async function loadOffering(
  offeringName: string,
  agentDirName: string
): Promise<LoadedOffering> {
  const offeringDir = path.resolve(resolveOfferingsRoot(agentDirName), offeringName);

  // offering.json
  const configPath = path.join(offeringDir, "offering.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`offering.json not found: ${configPath}`);
  }
  const config: OfferingConfig = parseOfferingConfig(configPath);

  // handlers.ts (dynamically imported)
  const handlersPath = path.join(offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) {
    throw new Error(`handlers.ts not found: ${handlersPath}`);
  }

  const handlers = (await import(handlersPath)) as OfferingHandlers;

  if (typeof handlers.executeJob !== "function") {
    throw new Error(`handlers.ts in "${offeringName}" must export an executeJob function`);
  }

  return { config, handlers };
}

/**
 * List all available offering names for a given agent.
 */
export function listOfferings(agentDirName: string): string[] {
  const offeringsRoot = resolveOfferingsRoot(agentDirName);
  if (!fs.existsSync(offeringsRoot)) return [];
  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Validate a seller's local offering directory against the canonical catalog.
 *
 * This is used as a startup fail-fast guard to prevent the runtime from serving
 * stale, missing, or extra offerings for catalogs that must stay in lock-step
 * with ACP registration.
 */
export function validateCanonicalCatalog(
  agentDirName: string,
  discoveredOfferings: string[] = listOfferings(agentDirName),
  catalogOverride?: readonly CanonicalOffering[]
): CanonicalCatalogValidationResult {
  const catalog = catalogOverride ?? getCanonicalCatalog(agentDirName);
  const issues: CanonicalCatalogValidationIssue[] = [];

  if (catalog.length === 0) {
    return {
      ok: true,
      catalog,
      discoveredOfferings,
      issues,
    };
  }

  const canonicalByName = new Map(catalog.map((offering) => [offering.name, offering]));
  const canonicalNames = new Set(canonicalByName.keys());

  for (const offering of catalog) {
    if (!discoveredOfferings.includes(offering.name)) {
      issues.push({
        type: "missing_offering",
        offeringName: offering.name,
        message: `Missing canonical offering directory: ${offering.name}`,
      });
    }
  }

  for (const localOffering of discoveredOfferings) {
    if (!canonicalNames.has(localOffering)) {
      issues.push({
        type: "extra_offering",
        offeringName: localOffering,
        message: `Unexpected non-canonical offering directory: ${localOffering}`,
      });
    }
  }

  for (const [offeringName, canonicalOffering] of canonicalByName) {
    if (!discoveredOfferings.includes(offeringName)) {
      continue;
    }

    const offeringJsonPath = resolveOfferingJsonPath(agentDirName, offeringName);

    if (!fs.existsSync(offeringJsonPath)) {
      issues.push({
        type: "missing_offering_json",
        offeringName,
        message: `Missing offering.json for canonical offering: ${offeringName}`,
      });
      continue;
    }

    let parsed: OfferingConfig;
    try {
      parsed = parseOfferingConfig(offeringJsonPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        type: "invalid_offering_json",
        offeringName,
        message: `Invalid offering.json for ${offeringName}: ${message}`,
      });
      continue;
    }

    if (typeof parsed.jobFee !== "number" || Number.isNaN(parsed.jobFee)) {
      issues.push({
        type: "invalid_job_fee",
        offeringName,
        message: `Invalid jobFee for ${offeringName}: expected numeric value`,
      });
      continue;
    }

    if (!hasMatchingPrice(canonicalOffering.jobFee, parsed.jobFee)) {
      issues.push({
        type: "price_mismatch",
        offeringName,
        message:
          `Price mismatch for ${offeringName}: expected ${formatPrice(canonicalOffering.jobFee)} ` +
          `(${canonicalOffering.registryTier}), found ${formatPrice(parsed.jobFee)}`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    catalog,
    discoveredOfferings,
    issues,
  };
}

export function assertCanonicalCatalogOrThrow(
  agentDirName: string,
  discoveredOfferings?: string[],
  logger: Pick<typeof console, "error"> = console,
  catalogOverride?: readonly CanonicalOffering[]
): void {
  const result = validateCanonicalCatalog(agentDirName, discoveredOfferings, catalogOverride);
  if (result.ok) {
    return;
  }

  logger.error(`[seller] Canonical catalog check failed for agent dir "${agentDirName}"`);
  for (const issue of result.issues) {
    logger.error(`[seller]   - ${issue.message}`);
  }

  throw new Error(`Canonical catalog validation failed (${result.issues.length} issue(s))`);
}

export function logOfferingsStatus(
  agentDirName: string,
  offerings: string[],
  logger: Pick<typeof console, "log" | "warn"> = console
): void {
  if (offerings.length === 0) {
    logger.warn(`[seller] WARNING: No offerings discovered for agent dir "${agentDirName}"`);
  }

  logger.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );
}
