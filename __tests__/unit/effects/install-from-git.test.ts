import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installEffectFromGit,
  addEffect,
  updateEffect,
  removeEffect,
  listEffectPackages,
} from "@/lib/effects/install-from-git";
import { customEffectsDir } from "@/lib/effects/packages";
import { findEffect, clearCustomEffects } from "@/lib/effects/registry";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomEffectManifest } from "@/lib/effects/package-types";

const GOOD_MANIFEST: CustomEffectManifest = {
  id: "slow-drift",
  name: "Slow Drift",
  family: "animation",
  phases: ["loop"],
  supports: ["text"],
  params: [],
};
const GOOD_SOURCE = "return { dx: progress * 10 };";

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.LIBI_HOME;
  home = mkdtempSync(join(tmpdir(), "libi-fx-home-"));
  process.env.LIBI_HOME = home;
  clearCustomEffects();
});

afterEach(() => {
  clearCustomEffects();
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("installEffectFromGit", () => {
  it("clones a valid package, persists it, and registers it", async () => {
    const clone = async (_url: string, dir: string) => {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(GOOD_MANIFEST));
      writeFileSync(join(dir, "animate.js"), GOOD_SOURCE);
    };
    const r = await installEffectFromGit({ url: "https://example.com/x.git", clone });
    expect(r).toEqual({ ok: true, id: "slow-drift" });
    // Landed at <effectsDir>/<id>/
    const dir = join(customEffectsDir(), "slow-drift");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "animate.js"))).toBe(true);
    // Registered
    expect(findEffect("slow-drift")).toBeTruthy();
  });

  it("rejects an INVALID package and does NOT persist", async () => {
    const clone = async (_url: string, dir: string) => {
      // Missing required fields → manifest validation fails.
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "bad" }));
      writeFileSync(join(dir, "animate.js"), GOOD_SOURCE);
    };
    const r = await installEffectFromGit({ url: "https://example.com/bad.git", clone });
    expect(r.ok).toBe(false);
    // Not persisted under the effects dir.
    expect(existsSync(join(customEffectsDir(), "bad"))).toBe(false);
    expect(findEffect("bad")).toBeFalsy();
  });

  it("rejects a clone that produces no manifest", async () => {
    const clone = async (_url: string, _dir: string) => {
      /* writes nothing */
    };
    const r = await installEffectFromGit({ url: "https://example.com/empty.git", clone });
    expect(r.ok).toBe(false);
  });

  it("rejects non-http(s) transports WITHOUT invoking git (RC-A)", async () => {
    let cloneCalled = false;
    const clone = async () => {
      cloneCalled = true;
    };
    for (const url of [
      'ext::sh -c "touch /tmp/pwned"',
      "file:///etc/passwd",
      "fd::0",
      "ssh://git@example.com/x.git",
      "git://example.com/x.git",
    ]) {
      const r = await installEffectFromGit({ url, clone });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/http/);
    }
    expect(cloneCalled).toBe(false);
  });

  it("accepts http and https transports", async () => {
    const clone = async (_url: string, dir: string) => {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(GOOD_MANIFEST));
      writeFileSync(join(dir, "animate.js"), GOOD_SOURCE);
    };
    for (const url of ["https://github.com/a/b.git", "http://example.com/a/b.git"]) {
      clearCustomEffects();
      rmSync(join(customEffectsDir(), "slow-drift"), { recursive: true, force: true });
      const r = await installEffectFromGit({ url, clone });
      expect(r.ok).toBe(true);
    }
  });
});

describe("addEffect", () => {
  it("writes a validated package and registers it", async () => {
    const r = await addEffect({ manifest: GOOD_MANIFEST, source: GOOD_SOURCE });
    expect(r).toEqual({ ok: true, id: "slow-drift" });
    expect(existsSync(join(customEffectsDir(), "slow-drift", "manifest.json"))).toBe(true);
    expect(findEffect("slow-drift")).toBeTruthy();
  });

  it("rejects an invalid source (sandbox) without writing", async () => {
    const r = await addEffect({ manifest: GOOD_MANIFEST, source: "fetch('http://evil'); return {};" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(customEffectsDir(), "slow-drift"))).toBe(false);
  });
});

describe("updateEffect", () => {
  it("patches the source of an existing package after re-validation", async () => {
    await addEffect({ manifest: GOOD_MANIFEST, source: GOOD_SOURCE });
    const r = await updateEffect({ id: "slow-drift", source: "return { dy: progress * 5 };" });
    expect(r.ok).toBe(true);
    expect(findEffect("slow-drift")).toBeTruthy();
  });

  it("rejects a patch that fails validation, keeping the prior package", async () => {
    await addEffect({ manifest: GOOD_MANIFEST, source: GOOD_SOURCE });
    const r = await updateEffect({ id: "slow-drift", source: "fetch('http://evil');" });
    expect(r.ok).toBe(false);
    // Old package still on disk + registered.
    expect(findEffect("slow-drift")).toBeTruthy();
  });
});

describe("removeEffect", () => {
  it("deletes the package and unregisters it", async () => {
    await addEffect({ manifest: GOOD_MANIFEST, source: GOOD_SOURCE });
    const r = await removeEffect({ id: "slow-drift" });
    expect(r.ok).toBe(true);
    expect(existsSync(join(customEffectsDir(), "slow-drift"))).toBe(false);
    expect(findEffect("slow-drift")).toBeFalsy();
  });

  it("rejects a traversal id without touching disk", async () => {
    const r = await removeEffect({ id: "../../etc" });
    expect(r.ok).toBe(false);
  });
});

describe("listEffectPackages", () => {
  it("reports valid and invalid on-disk packages", async () => {
    await addEffect({ manifest: GOOD_MANIFEST, source: GOOD_SOURCE });
    // Hand-write an invalid package alongside.
    const bad = join(customEffectsDir(), "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "manifest.json"), "{ not json");
    const list = await listEffectPackages();
    const slow = list.find((p) => p.id === "slow-drift");
    const broken = list.find((p) => p.id === "broken");
    expect(slow?.valid).toBe(true);
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
  });
});
