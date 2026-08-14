import { describe, it, expect } from "vitest";
import { resolve3DFont, geometryCacheKey } from "@/lib/engine/text-3d/font-resolve";
import { DEFAULT_3D_FONTS } from "@/lib/engine/text-3d/fonts";
const fileById = (id: string) => id === "up1" ? { id, filename: "MyFont.ttf", pieceId: "p1" } : null;
describe("resolve3DFont", () => {
  it("prefers an uploaded fontFileId (.ttf) → file path", () => {
    expect(resolve3DFont({ fontFamily: "Whatever", fontFileId: "up1" }, fileById).kind).toBe("file");
  });
  it("falls back to 2.5D for a .woff2-only upload", () => {
    const woff = (_id: string) => ({ id: "up1", filename: "Web.woff2", pieceId: "p1" });
    expect(resolve3DFont({ fontFamily: "X", fontFileId: "up1" }, woff).kind).toBe("faux");
  });
  it("uses a bundled face when the family is a known default", () => {
    expect(resolve3DFont({ fontFamily: DEFAULT_3D_FONTS[0].family }, () => null).kind).toBe("file");
  });
  it("defaults to REAL 3D (a bundled face) for an unrecognized/system family", () => {
    // Real 3D is the default; faux is reserved for an explicitly-unsupported upload.
    const r = resolve3DFont({ fontFamily: "Helvetica Neue" }, () => null);
    expect(r.kind).toBe("file");
    if (r.kind === "file") expect(r.source).toBe("bundled");
  });
  it("defaults to REAL 3D when no family is given at all", () => {
    expect(resolve3DFont({}, () => null).kind).toBe("file");
  });
});
describe("geometryCacheKey", () => {
  it("is stable for the same inputs", () => { expect(geometryCacheKey("/f.ttf","Hi",10,2)).toBe(geometryCacheKey("/f.ttf","Hi",10,2)); });
  it("differs on depth", () => { expect(geometryCacheKey("/f.ttf","Hi",10,2)).not.toBe(geometryCacheKey("/f.ttf","Hi",11,2)); });
});
