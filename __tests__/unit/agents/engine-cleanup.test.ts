import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupEnginePackages, enginePackageDirs } from "@/lib/agents/engine-cleanup";

let root: string;
let outside: string;
function mk(rel: string, bytes = 10, base = root): void {
  const f = path.join(base, rel, "bin");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(bytes));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-engine-cleanup-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "libi-engine-cleanup-outside-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("engine cleanup — the agent engines an older libi downloaded", () => {
  it("names the platform packages in every npm layout, never the adapters or the JS launchers", () => {
    const dirs = enginePackageDirs("/r");
    expect(dirs).toContain(path.join("/r", "node_modules", "@anthropic-ai"));
    expect(dirs).toContain(path.join("/r", "node_modules", "@openai"));
    expect(dirs).toContain(path.join("/r", "node_modules", "@agentclientprotocol", "claude-agent-acp", "node_modules", "@anthropic-ai"));
    expect(dirs).toContain(path.join("/r", "node_modules", "@agentclientprotocol", "codex-acp", "node_modules", "@openai"));
  });

  it("deletes claude-agent-sdk-* and codex-* dirs, keeps @anthropic-ai/claude-agent-sdk and @openai/codex, reports bytes", () => {
    mk("node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64", 1000);
    mk("node_modules/@anthropic-ai/claude-agent-sdk", 5);
    mk("node_modules/@openai/codex-darwin-arm64", 2000);
    mk("node_modules/@openai/codex", 5);
    mk("node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex-linux-x64", 300);
    mk("node_modules/@openai/codex-sdk", 5); // NOT a platform package — must survive every boot
    const r = cleanupEnginePackages(root);
    expect(r.removed).toBe(3);
    expect(r.bytesFreed).toBe(3300);
    expect(fs.existsSync(path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk"))).toBe(true);
    expect(fs.existsSync(path.join(root, "node_modules/@openai/codex"))).toBe(true);
    expect(fs.existsSync(path.join(root, "node_modules/@openai/codex-sdk"))).toBe(true);
    expect(fs.existsSync(path.join(root, "node_modules/@openai/codex-darwin-arm64"))).toBe(false);
  });

  it("is idempotent and tolerates a missing root", () => {
    expect(cleanupEnginePackages(root)).toEqual({ removed: 0, bytesFreed: 0 });
    expect(cleanupEnginePackages(path.join(root, "nope"))).toEqual({ removed: 0, bytesFreed: 0 });
  });

  it("never follows a symlinked engine dir out of the agent root — the link and its target stay", () => {
    // A user who `npm link`ed a local build, or anything else pointing a
    // platform-package name at a directory elsewhere, must not lose that
    // directory to a boot-time cleanup of the agent root.
    mk("codex-darwin-arm64-real", 4096, outside);
    const target = path.join(outside, "codex-darwin-arm64-real");
    const link = path.join(root, "node_modules", "@openai", "codex-darwin-arm64");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "dir");

    expect(cleanupEnginePackages(root)).toEqual({ removed: 0, bytesFreed: 0 });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(target, "bin")).size).toBe(4096);
  });

  it("never follows a symlinked scope dir (or a symlink above it) out of the agent root", () => {
    mk("scope/claude-agent-sdk-darwin-arm64", 1000, outside);
    mk("pkg/node_modules/@openai/codex-linux-x64", 300, outside);
    fs.mkdirSync(path.join(root, "node_modules", "@agentclientprotocol"), { recursive: true });
    fs.symlinkSync(path.join(outside, "scope"), path.join(root, "node_modules", "@anthropic-ai"), "dir");
    fs.symlinkSync(
      path.join(outside, "pkg"),
      path.join(root, "node_modules", "@agentclientprotocol", "codex-acp"),
      "dir",
    );

    expect(cleanupEnginePackages(root)).toEqual({ removed: 0, bytesFreed: 0 });
    expect(fs.existsSync(path.join(outside, "scope/claude-agent-sdk-darwin-arm64/bin"))).toBe(true);
    expect(fs.existsSync(path.join(outside, "pkg/node_modules/@openai/codex-linux-x64/bin"))).toBe(true);
  });
});
