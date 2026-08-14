import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string; let prev: string | undefined;
beforeEach(() => { prev = process.env.LIBI_HOME; home = mkdtempSync(join(tmpdir(), "libi-presets-")); process.env.LIBI_HOME = home; });
afterEach(() => { if (prev === undefined) delete process.env.LIBI_HOME; else process.env.LIBI_HOME = prev; rmSync(home, { recursive: true, force: true }); });

async function store() { return await import("@/lib/overlays/preset-store"); }

describe("preset-store", () => {
  it("save → list → get → delete round-trips a user preset", async () => {
    const s = await store();
    await s.saveUserPreset({ id: "gold-look", name: "Gold Look", kind: "text", source: "user", fields: { color: "#ffd400" } });
    expect((await s.listUserPresets()).map((p) => p.id)).toContain("gold-look");
    expect((await s.getUserPreset("gold-look"))?.fields.color).toBe("#ffd400");
    await s.deleteUserPreset("gold-look");
    expect(await s.getUserPreset("gold-look")).toBeNull();
  });
  it("listPresets merges bundled + user, user shadows bundled by id, filters by kind", async () => {
    const s = await store();
    await s.saveUserPreset({ id: "clean", name: "My Clean", kind: "text", source: "user", fields: { color: "#abcdef" } });
    const text = await s.listPresets("text");
    const clean = text.filter((p) => p.id === "clean");
    expect(clean).toHaveLength(1);                 // shadowed, not duplicated
    expect(clean[0].name).toBe("My Clean");        // user wins
    expect(clean[0].source).toBe("user");
    const imageList = await s.listPresets("image");
    expect(imageList.every((p) => p.kind === "image")).toBe(true);
  });
  it("rejects an invalid slug on save", async () => {
    const s = await store();
    await expect(s.saveUserPreset({ id: "../evil", name: "x", kind: "text", source: "user", fields: {} })).rejects.toThrow();
  });
});
