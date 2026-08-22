import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("libi-tracking install plan", () => {
  const md = fs.readFileSync(
    path.resolve("mcp/bundled-mcps/plans/libi-tracking.md"),
    "utf-8",
  );

  it("names libi.install_tracking_engine as the tool that installs", () => {
    expect(md).toContain("libi.install_tracking_engine");
    // The close of the loop stays explicit: install → verify → retry.
    expect(md).toContain("libi.verify_install");
  });

  it("never tells the agent that update_dep_status performs or drives an install", () => {
    // The 2026-08 regression: step 2 told the agent to use get_install_plan +
    // update_dep_status to "drive and attest the installer". Neither installs
    // anything — an agent following that loop announced a 10–20 minute install
    // and installed nothing. update_dep_status may appear only as a
    // status-recording call, never as the thing that runs the install.
    const sentences = md.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (!/update_dep_status/.test(sentence)) continue;
      expect(sentence).not.toMatch(/\b(drive|drives|driving|perform|performs|run the install|installs the|to install)\b/i);
    }
    // And the plan must say outright what it actually is.
    expect(md).toMatch(/update_dep_status[\s\S]{0,200}?(records|status)/i);
  });

  it("uses the real parameter name mcpId in every install-flow example", () => {
    // updateDepStatusSchema / getInstallPlanSchema take `mcpId`; an `id` key
    // silently fails validation.
    expect(md).toContain('libi.get_install_plan({ mcpId: "libi-tracking" })');
    expect(md).not.toMatch(/get_install_plan\(\{\s*id:/);
    expect(md).not.toMatch(/update_dep_status\(\{\s*id:/);
  });

  it("makes the agent disclose cost and get approval before installing", () => {
    expect(md).toMatch(/10–20 min/);
    expect(md).toMatch(/~2 GB/);
    expect(md).toMatch(/approval/i);
  });
});
