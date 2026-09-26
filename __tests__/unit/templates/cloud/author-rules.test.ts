import { describe, expect, it } from "vitest";
import { CREATOR_KEY_PATTERN, parseNickname } from "@/lib/templates/cloud/author-rules";
import { CREATOR_KEY_PATTERN as SERVER_PATTERN } from "@/lib/templates/cloud/identity";

describe("parseNickname — the site's rule (libi-site lib/templates/shape.ts#parseNickname)", () => {
  it("trims, collapses runs of spaces, and accepts 2–32 of letters, digits, space, - and _", () => {
    expect(parseNickname("  Nadav    N  ")).toEqual({ ok: true, nickname: "Nadav N" });
    expect(parseNickname("ab")).toEqual({ ok: true, nickname: "ab" });
    expect(parseNickname("a_b-c 9")).toEqual({ ok: true, nickname: "a_b-c 9" });
    expect(parseNickname("x".repeat(32))).toMatchObject({ ok: true });
  });

  it("refuses too short, too long, other characters, and no letter or digit", () => {
    for (const bad of ["", "x", "x".repeat(33), "<x>", "nadav!", "ñandú", "--", "_ _", "a\tb"]) {
      expect(parseNickname(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it("refuses bidi, control and TAG characters, and anything invisible at an edge", () => {
    for (const bad of ["na‮dav", "na⁦dav", "na\u0000dav", "na\u007fdav", "\u{e0041}nadav", "nadav​", "​nadav", "na dav"]) {
      const r = parseNickname(bad);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(parseNickname("na‮dav")).toMatchObject({ error: expect.stringMatching(/direction-changing/) });
  });
});

describe("CREATOR_KEY_PATTERN", () => {
  it("is one definition, shared with the server's identity module", () => {
    expect(SERVER_PATTERN).toBe(CREATOR_KEY_PATTERN);
    expect(CREATOR_KEY_PATTERN.test("a".repeat(43))).toBe(true);
    expect(CREATOR_KEY_PATTERN.test("a".repeat(42))).toBe(false);
    expect(CREATOR_KEY_PATTERN.test("a".repeat(42) + "=")).toBe(false);
  });
});
