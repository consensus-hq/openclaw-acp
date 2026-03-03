import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listOfferings, loadOffering, logOfferingsStatus } from "../runtime/offerings.js";

const OFFERINGS_ROOT = path.resolve(process.cwd(), "src/seller/offerings");

describe("offerings runtime", () => {
  it("listOfferings discovers all Guardian offerings", () => {
    const offerings = listOfferings("guardian");

    expect(offerings).toContain("guardian_scan_quick");
    expect(offerings).toContain("guardian_scan_standard");
    expect(offerings).toContain("guardian_scan_deep");
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
});
