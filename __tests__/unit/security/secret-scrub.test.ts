import { describe, it, expect } from "vitest";
import { scrubSecrets } from "@/lib/security/secret-scrub";

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
