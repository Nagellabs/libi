import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCaptionStyle,
  listCaptionStylesTool,
  deleteCaptionStyle,
} from "@/mcp/tools/caption-style-tools";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "libi-caption-style-"));
  process.env.LIBI_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

describe("createCaptionStyle — agent-authored static looks", () => {
  it("persists a new user style and surfaces it in the style list", async () => {
    const r = await createCaptionStyle({
      name: "My Glow",
      color: "#ffee00",
      fontWeight: 700,
      shadow: { color: "rgba(0,240,255,0.9)", blur: 18, dx: 0, dy: 0 },
    });
    expect(r.success).toBe(true);
    expect(r.data?.styleId).toBe("my-glow");

    const list = await listCaptionStylesTool();
    const styles = (list.data?.styles ?? []) as Array<Record<string, unknown>>;
    const mine = styles.find((s) => s.id === "my-glow");
    expect(mine).toBeTruthy();
    expect(mine!.source).toBe("user");
    expect(mine!.color).toBe("#ffee00");
    expect(mine!.shadow).toEqual({ color: "rgba(0,240,255,0.9)", blur: 18, dx: 0, dy: 0 });
    // The bundled curated looks are still present alongside the user one.
    expect(styles.some((s) => s.id === "clean")).toBe(true);
  });

  it("a second save with the SAME name (no override) returns style_name_exists", async () => {
    await createCaptionStyle({ name: "My Glow", color: "#fff" });
    const r = await createCaptionStyle({ name: "My Glow", color: "#000" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("style_name_exists");
    expect(r.data?.styleId).toBe("my-glow");
  });

  it("override:true replaces the fields", async () => {
    await createCaptionStyle({ name: "My Glow", color: "#ffffff" });
    const r = await createCaptionStyle({ name: "My Glow", color: "#00ff00", override: true });
    expect(r.success).toBe(true);
    const list = await listCaptionStylesTool();
    const styles = (list.data?.styles ?? []) as Array<Record<string, unknown>>;
    expect(styles.filter((s) => s.id === "my-glow")).toHaveLength(1);
    expect(styles.find((s) => s.id === "my-glow")!.color).toBe("#00ff00");
  });

  it("a name colliding with a bundled look is reserved", async () => {
    const r = await createCaptionStyle({ name: "Clean", color: "#fff", override: true });
    expect(r.success).toBe(false);
    expect(r.error).toBe("style_name_reserved");
  });

  it("delete removes a user style; bundled ids are reserved", async () => {
    await createCaptionStyle({ name: "My Glow", color: "#fff" });
    const del = await deleteCaptionStyle({ styleId: "my-glow" });
    expect(del.success).toBe(true);
    const list = await listCaptionStylesTool();
    const styles = (list.data?.styles ?? []) as Array<Record<string, unknown>>;
    expect(styles.some((s) => s.id === "my-glow")).toBe(false);

    const delBundled = await deleteCaptionStyle({ styleId: "clean" });
    expect(delBundled.success).toBe(false);
    expect(delBundled.error).toBe("style_name_reserved");
  });
});
