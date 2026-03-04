import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { X402JANUS_CANONICAL_CATALOG } from "../offerings/canonical-catalog.js";
import {
  assertCanonicalCatalogOrThrow,
  listOfferings,
  loadOffering,
  logOfferingsStatus,
  validateCanonicalCatalog,
} from "../runtime/offerings.js";

const OFFERINGS_ROOT = path.resolve(process.cwd(), "src/seller/offerings");

function scaffoldCanonicalOfferings(agentDirName: string): string {
  const agentRoot = path.join(OFFERINGS_ROOT, agentDirName);
  fs.mkdirSync(agentRoot, { recursive: true });

  for (const offering of X402JANUS_CANONICAL_CATALOG) {
    const offeringDir = path.join(agentRoot, offering.name);
    fs.mkdirSync(offeringDir, { recursive: true });
    fs.writeFileSync(
      path.join(offeringDir, "offering.json"),
      JSON.stringify(
        {
          name: offering.name,
          description: "test",
          jobFee: offering.jobFee,
          jobFeeType: "fixed",
          requiredFunds: false,
        },
        null,
        2
      ) + "\n"
    );
  }

  return agentRoot;
}

describe("offerings runtime", () => {
  it("listOfferings discovers all canonical x402janus offerings", () => {
    const offerings = listOfferings("x402janus");

    expect(offerings).toContain("x402janus_scan_quick");
    expect(offerings).toContain("x402janus_scan_standard");
    expect(offerings).toContain("x402janus_scan_deep");
    expect(offerings).toContain("x402janus_approvals");
    expect(offerings).toContain("x402janus_revoke");
    expect(offerings).toContain("x402janus_revoke_batch");
  });

  it("loadOffering throws when offering.json or handlers.ts is missing", async () => {
    const agentDirName = `test_agent_${Date.now()}`;
    const agentRoot = path.join(OFFERINGS_ROOT, agentDirName);
    const missingJsonDir = path.join(agentRoot, "missing_json");
    const missingHandlersDir = path.join(agentRoot, "missing_handlers");

    fs.mkdirSync(missingJsonDir, { recursive: true });
    fs.mkdirSync(missingHandlersDir, { recursive: true });

    fs.writeFileSync(
      path.join(missingJsonDir, "handlers.ts"),
      "export async function executeJob(){ return { deliverable: 'ok' }; }\n"
    );

    fs.writeFileSync(
      path.join(missingHandlersDir, "offering.json"),
      JSON.stringify(
        {
          name: "missing_handlers",
          description: "test",
          jobFee: 1,
          jobFeeType: "fixed",
          requiredFunds: false,
        },
        null,
        2
      ) + "\n"
    );

    try {
      await expect(loadOffering("missing_json", agentDirName)).rejects.toThrow(
        /offering\.json not found/
      );
      await expect(loadOffering("missing_handlers", agentDirName)).rejects.toThrow(
        /handlers\.ts not found/
      );
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it("zero offerings regression: warning is logged when offerings are empty", () => {
    const agentDirName = `test_empty_${Date.now()}`;
    const agentRoot = path.join(OFFERINGS_ROOT, agentDirName);
    fs.mkdirSync(agentRoot, { recursive: true });

    try {
      const offerings = listOfferings(agentDirName);
      expect(offerings.length).toBe(0);

      const warnings: string[] = [];
      const logs: string[] = [];

      logOfferingsStatus(agentDirName, offerings, {
        warn: (msg: string) => warnings.push(msg),
        log: (msg: string) => logs.push(msg),
      });

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/WARNING: No offerings discovered/);
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatch(/Available offerings: \(none\)/);
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it("canonical catalog validation passes when offerings match", () => {
    const result = validateCanonicalCatalog("x402janus");
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("canonical catalog validation detects missing offerings", () => {
    const agentDirName = `test_missing_${Date.now()}`;
    const agentRoot = scaffoldCanonicalOfferings(agentDirName);

    fs.rmSync(path.join(agentRoot, "x402janus_scan_deep"), { recursive: true, force: true });

    try {
      const result = validateCanonicalCatalog(agentDirName, undefined, X402JANUS_CANONICAL_CATALOG);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === "missing_offering")).toBe(true);
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it("canonical catalog validation detects extra non-canonical offerings", () => {
    const agentDirName = `test_extra_${Date.now()}`;
    const agentRoot = scaffoldCanonicalOfferings(agentDirName);
    const extraDir = path.join(agentRoot, "surprise_offering");
    fs.mkdirSync(extraDir, { recursive: true });

    try {
      const result = validateCanonicalCatalog(agentDirName, undefined, X402JANUS_CANONICAL_CATALOG);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === "extra_offering")).toBe(true);
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it("canonical catalog validation detects price mismatches", () => {
    const agentDirName = `test_price_${Date.now()}`;
    const agentRoot = scaffoldCanonicalOfferings(agentDirName);
    const quickJsonPath = path.join(agentRoot, "x402janus_scan_quick", "offering.json");

    const quickOffering = JSON.parse(fs.readFileSync(quickJsonPath, "utf-8"));
    quickOffering.jobFee = 1;
    fs.writeFileSync(quickJsonPath, JSON.stringify(quickOffering, null, 2) + "\n");

    try {
      const result = validateCanonicalCatalog(agentDirName, undefined, X402JANUS_CANONICAL_CATALOG);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === "price_mismatch")).toBe(true);
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it("assertCanonicalCatalogOrThrow fails fast on catalog drift", () => {
    const agentDirName = `test_failfast_${Date.now()}`;
    const agentRoot = scaffoldCanonicalOfferings(agentDirName);
    fs.rmSync(path.join(agentRoot, "x402janus_scan_standard"), { recursive: true, force: true });

    try {
      expect(() =>
        assertCanonicalCatalogOrThrow(
          agentDirName,
          undefined,
          undefined,
          X402JANUS_CANONICAL_CATALOG
        )
      ).toThrow(/Canonical catalog validation failed/);
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true });
    }
  });
});
