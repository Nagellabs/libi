import { describe, it, expect } from "vitest";
import { DEFAULT_3D_FONTS, defaultFontFor, bundledFontPath } from "@/lib/engine/text-3d/fonts";
import { existsSync } from "node:fs";
import { join } from "node:path";
describe("default 3D fonts", () => {
  it("exposes at least 2 bundled faces", () => { expect(DEFAULT_3D_FONTS.length).toBeGreaterThanOrEqual(2); });
  it("each bundled face file exists on disk", () => {
    for (const f of DEFAULT_3D_FONTS) expect(existsSync(join(process.cwd(),"public","fonts","3d",f.file))).toBe(true);
  });
  it("defaultFontFor returns a fallback for an unknown family", () => { expect(defaultFontFor("Totally Unknown Face")).toBeTruthy(); });
  it("bundledFontPath matches a known family case-insensitively", () => {
    const fam = DEFAULT_3D_FONTS[0].family; expect(bundledFontPath(fam.toLowerCase())).toContain(".ttf");
  });
});
