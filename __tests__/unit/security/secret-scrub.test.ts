import { describe, it, expect } from "vitest";
import { scrubSecrets, redactCliOutput } from "@/lib/security/secret-scrub";

describe("scrubSecrets", () => {
  it("redacts a secret occurrence", () => {
    const out = scrubSecrets("bad key sk_live_123 here", ["sk_live_123"]);
    expect(out).not.toContain("sk_live_123");
    expect(out).toContain("••••");
    expect(out).toBe("bad key •••• here");
  });

  it("redacts every occurrence and every secret", () => {
    const out = scrubSecrets("a=SECRET1 b=SECRET1 c=SECRET2", ["SECRET1", "SECRET2"]);
    expect(out).not.toContain("SECRET1");
    expect(out).not.toContain("SECRET2");
  });

  it("is a no-op on empty text", () => {
    expect(scrubSecrets("", ["x"])).toBe("");
  });

  it("skips empty / no secrets safely", () => {
    expect(scrubSecrets("hello", [""])).toBe("hello");
    expect(scrubSecrets("hello", [])).toBe("hello");
  });

  it("does not regex-interpret secret characters", () => {
    const out = scrubSecrets("token=a.b*c+d here", ["a.b*c+d"]);
    expect(out).toBe("token=•••• here");
  });
});

// Blanket redaction for CLI stderr that is about to leave the server (the
// `/api/providers/*` 502 bodies). Unlike scrubSecrets it knows no secret
// VALUES — libi never holds them — so it masks the two shapes a
// `claude`/`codex` failure could echo: a bearer token and a long `=value`.
describe("redactCliOutput", () => {
  it("masks a bearer token", () => {
    expect(redactCliOutput("401 for Authorization: Bearer sk-live-abc123 (retry)")).toBe(
      "401 for Authorization: Bearer *** (retry)",
    );
  });

  it("masks a long =value but leaves short ones alone", () => {
    expect(redactCliOutput("FAL_KEY=abcdefghijklmnopqrstuvwxyz0123 scope=user")).toBe(
      "FAL_KEY=*** scope=user",
    );
  });

  it("masks every occurrence, case-insensitively for the bearer word", () => {
    const out = redactCliOutput("bearer aaa then Bearer bbb and k=0123456789abcdefXYZ");
    expect(out).toBe("Bearer *** then Bearer *** and k=***");
  });

  it("is a no-op on empty and on clean text", () => {
    expect(redactCliOutput("")).toBe("");
    expect(redactCliOutput("No MCP server named 'x' in local scope")).toBe(
      "No MCP server named 'x' in local scope",
    );
  });
});
