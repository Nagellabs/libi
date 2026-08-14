import { describe, it, expect } from "vitest";
import { loadCustomEffectPayload } from "@/lib/effects/packages";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function manifest(id: string) {
  return JSON.stringify({
    id,
    name: id,
    family: "animation",
    phases: ["in"],
    supports: ["text"],
    params: [],
  });
}

describe("loadCustomEffectPayload", () => {
  it("includes only packages whose animate source compiles cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "fx-payload-"));

    const good = join(root, "good");
    mkdirSync(good);
    writeFileSync(join(good, "manifest.json"), manifest("good"));
    writeFileSync(join(good, "animate.js"), "return { opacity: progress };");

    // Poison: source references a forbidden global → scene-validator rejects it,
    // so compileCustomEffect returns { ok: false } and it must be omitted.
    const poison = join(root, "poison");
    mkdirSync(poison);
    writeFileSync(join(poison, "manifest.json"), manifest("poison"));
    writeFileSync(join(poison, "animate.js"), "return fetch('http://evil');");

    const { custom } = loadCustomEffectPayload(root);
    expect(custom.map((c) => c.meta.id)).toEqual(["good"]);
    expect(custom[0].source).toContain("opacity");
  });

  it("returns an empty list when the root does not exist", () => {
    const { custom } = loadCustomEffectPayload(join(tmpdir(), "fx-missing-xyz"));
    expect(custom).toEqual([]);
  });
});
