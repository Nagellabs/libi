import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  claudeNativeBinaryCandidates,
  claudeNativeBinaryMissingError,
  claudeNativeBinaryPresent,
  claudePlatformPackageNames,
  resolveClaudeNativeBinary,
} from "@/lib/agents/claude-native-binary";

/**
 * These assert the resolution logic against the adapter's own `claudeCliPath()`
 * (node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js) — if
 * libi's health check and the adapter disagree about where the binary lives,
 * the check is worse than useless: it either blesses a tree the adapter can't
 * use, or reinstalls forever over a tree that works.
 */

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "libi-agents-"));
  roots.push(root);
  return root;
}

function seedBinary(root: string, pkg: string, file = "claude"): string {
  const full = path.join(root, "node_modules", ...pkg.split("/"), file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "#!/bin/sh\n");
  chmodSync(full, 0o755);
  return full;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("claudePlatformPackageNames", () => {
  it("names the single platform package on darwin/win32", () => {
    expect(claudePlatformPackageNames({ platform: "darwin", arch: "arm64" })).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ]);
    expect(claudePlatformPackageNames({ platform: "win32", arch: "x64" })).toEqual([
      "@anthropic-ai/claude-agent-sdk-win32-x64",
    ]);
  });

  it("prefers the matching libc variant on linux, keeping the other as fallback", () => {
    // Both can be installed side by side; picking the wrong one segfaults at
    // runtime rather than failing to spawn, so order is load-bearing.
    expect(claudePlatformPackageNames({ platform: "linux", arch: "x64", musl: true })).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    ]);
    expect(claudePlatformPackageNames({ platform: "linux", arch: "x64", musl: false })).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    ]);
  });
});

describe("resolveClaudeNativeBinary", () => {
  const probe = { platform: "darwin" as const, arch: "arm64", env: {} };

  it("finds the hoisted platform package (the normal npm layout)", () => {
    const root = makeRoot();
    const bin = seedBinary(root, "@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(resolveClaudeNativeBinary(root, probe)).toBe(bin);
    expect(claudeNativeBinaryPresent(root, probe)).toBe(true);
  });

  it("finds a NESTED platform package (npm's layout when hoisting is blocked)", () => {
    const root = makeRoot();
    const bin = seedBinary(
      root,
      "@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
    );
    expect(resolveClaudeNativeBinary(root, probe)).toBe(bin);
  });

  it("returns null when the adapter is present but its platform package is not", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp"), {
      recursive: true,
    });
    expect(resolveClaudeNativeBinary(root, probe)).toBeNull();
    expect(claudeNativeBinaryPresent(root, probe)).toBe(false);
  });

  it("ignores the wrong platform's package", () => {
    const root = makeRoot();
    seedBinary(root, "@anthropic-ai/claude-agent-sdk-linux-x64");
    expect(claudeNativeBinaryPresent(root, probe)).toBe(false);
  });

  it("looks for claude.exe on win32", () => {
    const root = makeRoot();
    const winProbe = { platform: "win32" as const, arch: "x64", env: {} };
    seedBinary(root, "@anthropic-ai/claude-agent-sdk-win32-x64", "claude");
    expect(claudeNativeBinaryPresent(root, winProbe)).toBe(false);
    const exe = seedBinary(root, "@anthropic-ai/claude-agent-sdk-win32-x64", "claude.exe");
    expect(resolveClaudeNativeBinary(root, winProbe)).toBe(exe);
  });

  it("honours CLAUDE_CODE_EXECUTABLE ahead of any package lookup", () => {
    // The adapter execs this first, so a user pointing at their own install
    // has a working setup with no platform package at all.
    const root = makeRoot();
    expect(
      resolveClaudeNativeBinary(root, { ...probe, env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" } }),
    ).toBe("/opt/claude");
  });

  it("enumerates hoisted candidates before nested ones", () => {
    const candidates = claudeNativeBinaryCandidates("/root", probe);
    expect(candidates[0]).toBe(
      path.join("/root", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude"),
    );
    expect(candidates.length).toBeGreaterThan(1);
  });
});

describe("claudeNativeBinaryMissingError", () => {
  it("names the package, the cause, and both recoveries", () => {
    const msg = claudeNativeBinaryMissingError("/home/.libi/agents", {
      platform: "darwin",
      arch: "arm64",
    });
    expect(msg).toContain("@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(msg).toContain("/home/.libi/agents");
    // The non-obvious part a user cannot guess: npm reported success anyway.
    expect(msg).toContain("optional dependency");
    expect(msg).toContain("CLAUDE_CODE_EXECUTABLE");
  });
});
