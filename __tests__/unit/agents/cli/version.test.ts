import { describe, it, expect } from "vitest";
import { compareSemver, parseFirstSemver, satisfiesMinimum } from "@/lib/agents/cli/version";

describe("parseFirstSemver", () => {
  it("reads the first x.y.z out of the real --version formats", () => {
    expect(parseFirstSemver("2.1.245 (Claude Code)")).toBe("2.1.245");
    expect(parseFirstSemver("codex-cli 0.153.4")).toBe("0.153.4");
    expect(parseFirstSemver("v10.2.0\n")).toBe("10.2.0");
  });
  it("returns null when there is none (the resolver then reports foundButBroken)", () => {
    expect(parseFirstSemver("command not found")).toBeNull();
    expect(parseFirstSemver("")).toBeNull();
    expect(parseFirstSemver("1.2")).toBeNull();
  });
});

describe("compareSemver / satisfiesMinimum", () => {
  it("compares numerically, not lexically", () => {
    expect(compareSemver("2.1.245", "2.1.9")).toBe(1);
    expect(compareSemver("0.153.4", "0.153.4")).toBe(0);
    expect(compareSemver("0.9.0", "0.153.4")).toBe(-1);
  });
  it("satisfiesMinimum is >=", () => {
    expect(satisfiesMinimum("2.1.245", "2.1.245")).toBe(true);
    expect(satisfiesMinimum("2.1.244", "2.1.245")).toBe(false);
  });
});
