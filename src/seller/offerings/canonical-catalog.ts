export interface CanonicalOffering {
  name: string;
  registryTier: "quick" | "standard" | "deep" | "approvals" | "revoke" | "revoke_batch";
  jobFee: number;
}

export const X402JANUS_CANONICAL_CATALOG: readonly CanonicalOffering[] = [
  { name: "x402janus_scan_quick", registryTier: "quick", jobFee: 0.01 },
  { name: "x402janus_scan_standard", registryTier: "standard", jobFee: 0.05 },
  { name: "x402janus_scan_deep", registryTier: "deep", jobFee: 0.25 },
  { name: "x402janus_approvals", registryTier: "approvals", jobFee: 0.01 },
  { name: "x402janus_revoke", registryTier: "revoke", jobFee: 0.05 },
  { name: "x402janus_revoke_batch", registryTier: "revoke_batch", jobFee: 0.1 },
] as const;

const CANONICAL_CATALOG_BY_AGENT: Readonly<Record<string, readonly CanonicalOffering[]>> = {
  x402janus: X402JANUS_CANONICAL_CATALOG,
};

export function getCanonicalCatalog(agentDirName: string): readonly CanonicalOffering[] {
  return CANONICAL_CATALOG_BY_AGENT[agentDirName] ?? [];
}
