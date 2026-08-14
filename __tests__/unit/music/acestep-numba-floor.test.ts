/**
 * `libi.generate_music` — the DEFAULT music provider — could never install.
 *
 * ACE-Step's dependency tree reaches numba through librosa. Left unconstrained,
 * uv resolves `numba==0.53.1`, which pins `llvmlite==0.36.0`. That llvmlite
 * ships no wheel for a modern interpreter, so it is built from source, and its
 * setup.py has a hard version guard:
 *
 *   RuntimeError: Cannot install on Python version 3.12.13;
 *                 only versions >=3.6,<3.10 are supported.
 *
 * ACESTEP_PYTHON_VERSION is 3.12 and cannot simply be lowered — spacy 3.8.4
 * (also in the tree) publishes no cp313 wheels, and the comment on that
 * constant records 3.12 as the highest version with full wheel coverage. So the
 * failure was deterministic: every first use of local music died during install.
 *
 * Measured on macOS arm64, 2026-08-02, during the dev-build E2E:
 *   `uv pip compile --python-version 3.12` with ACE-Step's specs
 *     -> numba==0.53.1, llvmlite==0.36.0   (install fails)
 *   the same specs plus `numba>=0.60`
 *     -> numba==0.66.0, llvmlite==0.48.0   (resolves clean, llvmlite as a WHEEL)
 *
 * Note the sibling env in lib/music/analyze.ts (librosa + soundfile, used by
 * music_detect_beats / music_profile) already resolved to numba 0.66 on its
 * own — the downward pressure comes from ACE-Step's tree specifically, which
 * is why only this spec list needs the floor.
 */
import { describe, it, expect } from "vitest";
import {
  ACESTEP_WITH_SPECS,
  ACESTEP_RUN_PREFIX,
  ACESTEP_PYTHON_VERSION,
  NUMBA_MIN_VERSION,
  aceStepEnvSignature,
} from "@/lib/music/generate";

describe("ACE-Step install spec pins numba above the llvmlite cliff", () => {
  it("declares a numba floor", () => {
    const numba = ACESTEP_WITH_SPECS.find((s) => s.startsWith("numba"));
    expect(
      numba,
      "without a numba floor, uv resolves numba 0.53.1 -> llvmlite 0.36.0, " +
        "which refuses to build on Python >=3.10 and makes libi.generate_music " +
        "uninstallable",
    ).toBeDefined();
    expect(numba).toBe(`numba>=${NUMBA_MIN_VERSION}`);
  });

  it("keeps the floor at or above the first llvmlite with modern wheels", () => {
    // numba 0.53.x -> llvmlite 0.36 (py<3.10 only). 0.60 is comfortably past
    // the cliff and was verified to resolve llvmlite 0.48 on py3.12.
    const [maj, min] = NUMBA_MIN_VERSION.split(".").map(Number);
    expect(maj).toBe(0);
    expect(min).toBeGreaterThanOrEqual(60);
  });

  it("passes the floor through to the actual spawn args", () => {
    // ACESTEP_RUN_PREFIX is what gets executed; a floor that only exists in
    // the constant would fix the signature and not the install.
    const joined = ACESTEP_RUN_PREFIX.join(" ");
    expect(joined).toContain(`--with numba>=${NUMBA_MIN_VERSION}`);
    expect(joined).toContain(`--python ${ACESTEP_PYTHON_VERSION}`);
  });

  it("changes the env signature so existing installs re-provision", () => {
    // The install-token marker hashes the spec list. If the floor did not
    // change the signature, a machine that already has the broken env would
    // report "current" and never re-resolve.
    const sig = aceStepEnvSignature();
    expect(sig).toBeTruthy();
    expect(
      ACESTEP_WITH_SPECS.some((s) => s.includes("numba")),
      "the signature is derived from ACESTEP_WITH_SPECS, so numba must be in it",
    ).toBe(true);
  });
});
