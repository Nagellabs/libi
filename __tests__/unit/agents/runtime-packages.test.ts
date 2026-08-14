import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_ADAPTER_PACKAGE } from "@/lib/agents/runtime-packages";

/** Repo root — three levels up from __tests__/unit/agents/. */
const REPO_ROOT = path.resolve(__dirname, "../../..");

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(version: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`Not a semver version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Minimal caret-range containment check — enough to couple a pinned exact
 * version to package.json's caret range without pulling in an external
 * `semver` dependency this repo doesn't declare directly. Implements npm's
 * real caret semantics, including the 0.x.y special cases (only the segment
 * right of the leftmost non-zero one is allowed to float).
 */
function satisfiesCaretRange(range: string, version: string): boolean {
  const m = /^\^(\d+\.\d+\.\d+)/.exec(range.trim());
  if (!m) throw new Error(`Test only supports caret ranges (e.g. "^0.44.0"), got: ${range}`);
  const lower = parseSemVer(m[1]);
  const ver = parseSemVer(version);
  if (compareSemVer(ver, lower) < 0) return false;

  const upper: SemVer =
    lower.major > 0
      ? { major: lower.major + 1, minor: 0, patch: 0 }
      : lower.minor > 0
        ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 };
  return compareSemVer(ver, upper) < 0;
}

describe("satisfiesCaretRange (test helper self-check)", () => {
  it("accepts a version equal to the range floor", () => {
    expect(satisfiesCaretRange("^0.44.0", "0.44.0")).toBe(true);
  });

  it("accepts a patch bump within a 0.x floor", () => {
    expect(satisfiesCaretRange("^0.44.0", "0.44.3")).toBe(true);
  });

  it("rejects a minor bump for a 0.x floor (caret locks the minor when major is 0)", () => {
    expect(satisfiesCaretRange("^0.44.0", "0.45.0")).toBe(false);
  });

  it("rejects a version below the floor", () => {
    expect(satisfiesCaretRange("^0.44.0", "0.43.9")).toBe(false);
  });
});

describe("CLAUDE_ADAPTER_PACKAGE pin lockstep with package.json", () => {
  it("pins an exact x.y.z version, never a range", () => {
    expect(CLAUDE_ADAPTER_PACKAGE.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("satisfies package.json's own devDependency range for the same package", () => {
    // Regression: someone bumping package.json's
    // "@agentclientprotocol/claude-agent-acp" range while leaving this pin
    // behind would get dev running one adapter version (via the repo-local
    // node_modules/.bin short-circuit) and production installing another
    // (via lib/agents/runtime-install.ts) — silently divergent, no red test.
    const pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      devDependencies?: Record<string, string>;
    };
    const range = pkgJson.devDependencies?.[CLAUDE_ADAPTER_PACKAGE.npmPackage];
    expect(
      range,
      `package.json must declare a devDependency on ${CLAUDE_ADAPTER_PACKAGE.npmPackage} (NOT a regular dependency — a regular dependency would make npx libi and the packaged Electron artifact redistribute Anthropic's proprietary SDK)`,
    ).toBeDefined();
    expect(
      satisfiesCaretRange(range!, CLAUDE_ADAPTER_PACKAGE.pinnedVersion),
      `pinnedVersion ${CLAUDE_ADAPTER_PACKAGE.pinnedVersion} must satisfy package.json's range ${range} for ${CLAUDE_ADAPTER_PACKAGE.npmPackage} — bump both together`,
    ).toBe(true);
  });

  it("is NOT a regular dependency (would defeat the licence fix)", () => {
    const pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(
      pkgJson.dependencies?.[CLAUDE_ADAPTER_PACKAGE.npmPackage],
      `${CLAUDE_ADAPTER_PACKAGE.npmPackage} must not be a regular dependency — npx libi installs dependencies, which would redistribute the proprietary @anthropic-ai/claude-agent-sdk it transitively pulls`,
    ).toBeUndefined();
  });
});
