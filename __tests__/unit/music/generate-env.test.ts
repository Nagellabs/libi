import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ace-env-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("aceStepEnvSignature", () => {
  it("covers the git pin + torchcodec version + soundfile", async () => {
    const {
      aceStepEnvSignature,
      ACESTEP_INSTALL_SPEC,
      TORCHCODEC_VERSION,
    } = await import("@/lib/music/generate");
    const sig = aceStepEnvSignature();
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
    expect(ACESTEP_INSTALL_SPEC).toBeDefined();
    expect(TORCHCODEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("changes when TORCHCODEC_VERSION would change (hash sensitivity)", async () => {
    // We can't mutate the module-level constant, but we can verify the
    // helper is sensitive to its inputs by calling hashSpec directly with
    // the documented inputs.
    const { hashSpec } = await import("@/lib/uv-env/hash-spec");
    expect(hashSpec("3.12", ["ace-step@x", "soundfile", "torchcodec==0.12.0"])).not.toBe(
      hashSpec("3.12", ["ace-step@x", "soundfile", "torchcodec==0.13.0"]),
    );
  });

  it("is wired to the real ACESTEP_WITH_SPECS + ACESTEP_PYTHON_VERSION", async () => {
    // Regression: ACESTEP_RUN_PREFIX and aceStepEnvSignature used to
    // hard-code the same --with list independently; this assertion locks
    // the wiring so adding a dep to ACESTEP_WITH_SPECS can't silently
    // skip the signature update.
    const {
      aceStepEnvSignature,
      ACESTEP_WITH_SPECS,
      ACESTEP_PYTHON_VERSION,
    } = await import("@/lib/music/generate");
    const { hashSpec } = await import("@/lib/uv-env/hash-spec");
    expect(aceStepEnvSignature()).toBe(
      hashSpec(ACESTEP_PYTHON_VERSION, ACESTEP_WITH_SPECS),
    );
  });
});

describe("isAceStepEnvCurrent", () => {
  it("returns false when the token is missing", async () => {
    const { isAceStepEnvCurrent } = await import("@/lib/music/generate");
    expect(isAceStepEnvCurrent()).toBe(false);
  });

  it("returns true when the token matches the current signature", async () => {
    const { isAceStepEnvCurrent, aceStepEnvSignature } = await import("@/lib/music/generate");
    const { writeInstallToken } = await import("@/lib/uv-env/install-token");
    writeInstallToken(".libi-ace-step-env.install-token", aceStepEnvSignature());
    expect(isAceStepEnvCurrent()).toBe(true);
  });
});
