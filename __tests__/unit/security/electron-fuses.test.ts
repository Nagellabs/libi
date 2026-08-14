import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * RC-G Task 16: the packaged Electron build must disable the dangerous fuses that
 * let a local attacker repurpose the app binary as a Node runtime, attach a
 * debugger, or inject modules/CAs via env vars. electron-builder's native
 * `electronFuses` config key flips these after packing and re-signs the app.
 *
 * Full verification needs a packaged build (see the coordinator smoke check:
 * `ELECTRON_RUN_AS_NODE=1 <app binary> -e 'process.exit(0)'` must NOT execute).
 * This test asserts the config the build reads is correct.
 */
describe("electron-builder.yml — RC-G hardening fuses", () => {
  const config = yaml.load(
    fs.readFileSync(
      path.join(process.cwd(), "electron-builder.yml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;

  const fuses = config.electronFuses as Record<string, unknown> | undefined;

  it("declares an electronFuses block", () => {
    expect(fuses).toBeTypeOf("object");
  });

  it("disables RunAsNode (no ELECTRON_RUN_AS_NODE repurposing)", () => {
    expect(fuses?.runAsNode).toBe(false);
  });

  it("disables EnableNodeCliInspectArguments (no --inspect debugger attach)", () => {
    expect(fuses?.enableNodeCliInspectArguments).toBe(false);
  });

  it("disables EnableNodeOptionsEnvironmentVariable (no NODE_OPTIONS injection)", () => {
    expect(fuses?.enableNodeOptionsEnvironmentVariable).toBe(false);
  });

  it("does NOT enable onlyLoadAppFromAsar while asar is disabled", () => {
    // onlyLoadAppFromAsar requires asar: true; enabling it with asar: false
    // would break app loading. Guard against a drift where one is toggled
    // without the other.
    if (config.asar === false) {
      expect(fuses?.onlyLoadAppFromAsar).not.toBe(true);
    }
  });
});
