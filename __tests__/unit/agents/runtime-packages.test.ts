import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLAUDE_ADAPTER_PACKAGE,
  CODEX_ADAPTER_PACKAGE,
  RUNTIME_AGENT_PACKAGES,
  runtimeAgentPackage,
} from "@/lib/agents/runtime-packages";

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

describe("adapter pins are the versions this release ships", () => {
  it("pins claude-agent-acp at 0.75.1", () => {
    expect(CLAUDE_ADAPTER_PACKAGE.pinnedVersion).toBe("0.75.1");
  });

  it("declares codex-acp at 1.10.0 in package.json", () => {
    const pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range =
      pkgJson.dependencies?.["@agentclientprotocol/codex-acp"] ??
      pkgJson.devDependencies?.["@agentclientprotocol/codex-acp"];
    expect(range, "codex-acp must be declared somewhere in package.json").toBeDefined();
    expect(satisfiesCaretRange(range!.startsWith("^") ? range! : `^${range!}`, "1.10.0")).toBe(true);
  });
});

describe("CODEX_ADAPTER_PACKAGE", () => {
  it("is in RUNTIME_AGENT_PACKAGES next to the Claude adapter", () => {
    expect(RUNTIME_AGENT_PACKAGES.map((p) => p.npmPackage).sort()).toEqual([
      "@agentclientprotocol/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
    ]);
  });

  it("pins an exact x.y.z version that satisfies package.json's devDependency range", () => {
    expect(CODEX_ADAPTER_PACKAGE.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      devDependencies?: Record<string, string>;
    };
    const range = pkgJson.devDependencies?.[CODEX_ADAPTER_PACKAGE.npmPackage];
    expect(
      range,
      `${CODEX_ADAPTER_PACKAGE.npmPackage} must be a devDependency so npx libi and the packaged artifact stop carrying the 258 MB @openai/codex binary`,
    ).toBeDefined();
    expect(satisfiesCaretRange(range!, CODEX_ADAPTER_PACKAGE.pinnedVersion)).toBe(true);
  });

  it("is NOT a regular dependency (it is what makes the bundle 258 MB heavier)", () => {
    const pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkgJson.dependencies?.["@agentclientprotocol/codex-acp"]).toBeUndefined();
  });

  it("maps agent ids to packages", () => {
    expect(runtimeAgentPackage("codex")?.npmPackage).toBe("@agentclientprotocol/codex-acp");
    expect(runtimeAgentPackage("claude-code")?.npmPackage).toBe(
      "@agentclientprotocol/claude-agent-acp",
    );
    expect(runtimeAgentPackage("terminal")).toBeNull();
  });
});

/**
 * The progress bar's denominator used to be a side table
 * keyed by agent id with a bare 345 MB fallback, so a third agent would have
 * rendered Claude's bar. It is now a field on the package entry itself.
 */
describe("estimatedInstallBytes lives on every RuntimeAgentPackage", () => {
  it("is a positive byte count for each registered package", () => {
    for (const pkg of RUNTIME_AGENT_PACKAGES) {
      expect(pkg.estimatedInstallBytes, pkg.agentId).toBeGreaterThan(0);
    }
  });
});
