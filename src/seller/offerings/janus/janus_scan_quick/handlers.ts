import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { executeJanusJob, validateJanusRequirements } from "../janusShared.js";

const TIER = "quick" as const;

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateJanusRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  return executeJanusJob(requirement, TIER);
}
