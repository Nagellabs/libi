import { describe, it, expect } from "vitest";
import { canonicalHash } from "@/lib/jobs/canonical-hash";

describe("canonicalHash", () => {
  it("produces stable sha256 hex regardless of key order", () => {
    const a = canonicalHash({ fileId: "x", fps: 30, anchors: [{ time: 1, bbox: [0, 0, 10, 10] }] });
    const b = canonicalHash({ fps: 30, anchors: [{ bbox: [0, 0, 10, 10], time: 1 }], fileId: "x" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any value changes", () => {
    const a = canonicalHash({ fileId: "x", fps: 30 });
    const b = canonicalHash({ fileId: "x", fps: 60 });
    expect(a).not.toBe(b);
  });

  it("treats arrays as ordered (different order → different hash)", () => {
    const a = canonicalHash({ anchors: [{ t: 1 }, { t: 2 }] });
    const b = canonicalHash({ anchors: [{ t: 2 }, { t: 1 }] });
    expect(a).not.toBe(b);
  });

  it("handles null + undefined consistently", () => {
    expect(canonicalHash({ a: null })).toBe(canonicalHash({ a: null }));
    expect(canonicalHash({ a: undefined })).toBe(canonicalHash({}));
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalHash({ x: NaN })).toThrow(/non-finite/i);
    expect(() => canonicalHash({ x: Infinity })).toThrow(/non-finite/i);
    expect(() => canonicalHash({ x: -Infinity })).toThrow(/non-finite/i);
    expect(() => canonicalHash([1, NaN, 3])).toThrow(/non-finite/i);
  });
});
