import { describe, it, expect, afterEach } from "vitest";
import { loadCustomEffectsFromDisk } from "@/lib/effects/packages";
import { clearCustomEffects } from "@/lib/effects/registry";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => clearCustomEffects());

describe("loadCustomEffectsFromDisk", () => {
  it("loads valid packages and skips invalid ones", () => {
    const root = mkdtempSync(join(tmpdir(), "fx-"));
    const good = join(root, "good"); mkdirSync(good);
    writeFileSync(join(good, "manifest.json"), JSON.stringify({ id: "good", name: "Good", family: "animation", phases: ["in"], supports: ["text"], params: [] }));
    writeFileSync(join(good, "animate.js"), "return { opacity: progress };");
    const bad = join(root, "bad"); mkdirSync(bad);
    writeFileSync(join(bad, "manifest.json"), "{ not json");
    const { defs, errors } = loadCustomEffectsFromDisk(root);
    expect(defs.map((d) => d.meta.id)).toEqual(["good"]);
    expect(errors.length).toBe(1);
  });
});
