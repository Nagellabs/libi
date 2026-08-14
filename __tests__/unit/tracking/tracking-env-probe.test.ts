/**
 * Guards the gate used by the sidecar integration tests
 * (`__tests__/integration/tracking/engine-{selftest,runner}.test.ts`).
 *
 * On an unprovisioned machine those tests skip, so the "provisioned → run"
 * branch would otherwise never be exercised anywhere. Here it is, against a
 * synthetic home: `os.homedir()` honours `$HOME` on POSIX, so pointing HOME at
 * a temp dir lets us build both a provisioned and an unprovisioned layout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeTrackingEnv,
  useRealTrackingEnv,
  realLibiHome,
} from "@/__tests__/helpers/tracking-env";

const isWin = process.platform === "win32";
let tmpHome = "";
let savedHome: string | undefined;
let savedLibiHome: string | undefined;
let savedModels: string | undefined;

function touch(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o755);
}

/** Lay down the exact files `probeTrackingEnv` treats as "provisioned". */
function provision(home: string, opts: { models?: boolean } = {}): void {
  touch(path.join(home, ".libi", "bin", isWin ? "uv.exe" : "uv"));
  touch(
    isWin
      ? path.join(home, ".libi", "uv", "envs", "tracking", "Scripts", "python.exe")
      : path.join(home, ".libi", "uv", "envs", "tracking", "bin", "python"),
  );
  if (opts.models) {
    touch(path.join(home, ".libi", "models", "tracking", "yoloe11.onnx"));
  }
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedLibiHome = process.env.LIBI_HOME;
  savedModels = process.env.LIBI_TRACK_MODELS;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-track-env-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedLibiHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedLibiHome;
  if (savedModels === undefined) delete process.env.LIBI_TRACK_MODELS;
  else process.env.LIBI_TRACK_MODELS = savedModels;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("probeTrackingEnv", () => {
  it.skipIf(isWin)("reports a missing uv binary by name", () => {
    // Empty home + a PATH with no uv on it.
    const savedPath = process.env.PATH;
    process.env.PATH = tmpHome;
    try {
      const probe = probeTrackingEnv();
      expect(probe.missing).toContain("uv not found");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("reports an unbuilt venv rather than letting uv sync one", () => {
    touch(path.join(tmpHome, ".libi", "bin", isWin ? "uv.exe" : "uv"));
    const probe = probeTrackingEnv();
    expect(probe.missing).toContain("tracking python env not provisioned");
    // The directory alone must NOT count as provisioned — an empty/partial
    // venv dir is exactly what would trigger a ~1.2 GB `uv run` sync.
    fs.mkdirSync(path.join(tmpHome, ".libi", "uv", "envs", "tracking"), {
      recursive: true,
    });
    expect(probeTrackingEnv().missing).toContain("tracking python env not provisioned");
  });

  it("reports missing ONNX models only when they are required", () => {
    provision(tmpHome); // no models
    expect(probeTrackingEnv().missing).toBeNull();
    expect(probeTrackingEnv({ requireModels: true }).missing).toContain(
      "tracking ONNX models not installed",
    );
  });

  it("passes when uv, the venv and the models are all present", () => {
    provision(tmpHome, { models: true });
    const probe = probeTrackingEnv({ requireModels: true });
    expect(probe.missing).toBeNull();
    expect(probe.uv).toBe(path.join(tmpHome, ".libi", "bin", isWin ? "uv.exe" : "uv"));
    expect(probe.home).toBe(path.join(tmpHome, ".libi"));
  });

  it("honours config.json's libiHome, like getLibiHome does", () => {
    const custom = path.join(tmpHome, "elsewhere");
    fs.mkdirSync(path.join(tmpHome, ".libi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".libi", "config.json"),
      JSON.stringify({ libiHome: custom }),
    );
    expect(realLibiHome()).toBe(custom);
  });
});

describe("useRealTrackingEnv", () => {
  it("redirects LIBI_HOME + LIBI_TRACK_MODELS and restores them", () => {
    provision(tmpHome, { models: true });
    process.env.LIBI_HOME = "/tmp/isolated-by-vitest";
    delete process.env.LIBI_TRACK_MODELS;

    const probe = probeTrackingEnv({ requireModels: true });
    const restore = useRealTrackingEnv(probe);

    // LIBI_HOME is the single switch uvPath()/trackingVenvDir()/
    // trackingModelsDir() all derive from.
    expect(process.env.LIBI_HOME).toBe(path.join(tmpHome, ".libi"));
    expect(process.env.LIBI_TRACK_MODELS).toBe(
      path.join(tmpHome, ".libi", "models", "tracking"),
    );

    restore();
    expect(process.env.LIBI_HOME).toBe("/tmp/isolated-by-vitest");
    expect(process.env.LIBI_TRACK_MODELS).toBeUndefined();
  });
});
