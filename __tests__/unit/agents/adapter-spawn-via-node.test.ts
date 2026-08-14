/**
 * Defect D3 (second half): the Claude ACP adapter is
 * `node_modules/.bin/claude-agent-acp`, a `#!/usr/bin/env node` script.
 * Spawning it directly makes the adapter's availability depend on `node`
 * being on the PATH of the SPAWNING process — which, in a Finder-launched
 * packaged app whose login-shell PATH probe timed out, it is not.
 *
 * M9: the original version of this test asserted
 * `command: resolveNodeCommand()` — comparing the implementation against
 * itself, so it would pass no matter what `resolveNodeCommand()` actually
 * returned. These versions control `LIBI_HOME` so the expected value is
 * known independently: bare `"node"` when nothing is provisioned, the
 * absolute managed path once one is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("@/lib/agents/runtime-install", () => ({
  resolveRepoLocalAdapterBin: () => null,
  resolveInstalledAdapterBin: () => null,
  resolveClaudeAdapterBin: () => null,
}));

import { spawnViaNodeIfScript } from "@/lib/agents/acp/agent-registry";
import { managedNodePath, nodeBinaryName } from "@/lib/runtime/node-runtime";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.LIBI_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-adapter-spawn-"));
  process.env.LIBI_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("spawnViaNodeIfScript", () => {
  it("falls back to the bare 'node' name when no managed runtime is provisioned", () => {
    // No <LIBI_HOME>/bin/node exists in this fresh tmp dir, so the real
    // behaviour of resolveNodeCommand() is the bare binary name — asserted
    // here directly, not by calling resolveNodeCommand() itself.
    const shim = "/libi/agents/node_modules/.bin/claude-agent-acp";
    const real = "/libi/agents/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    expect(spawnViaNodeIfScript(shim, () => real)).toEqual({
      command: nodeBinaryName(),
      args: [real],
    });
  });

  it("uses the absolute managed node path once one is provisioned", () => {
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "#!/bin/sh\n", { mode: 0o755 });

    const shim = "/libi/agents/node_modules/.bin/claude-agent-acp";
    const real = "/libi/agents/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    expect(spawnViaNodeIfScript(shim, () => real)).toEqual({
      command: managed,
      args: [real],
    });
    expect(path.isAbsolute(managed)).toBe(true);
  });

  it("handles .mjs and .cjs entry points too", () => {
    expect(spawnViaNodeIfScript("/x/bin/a", () => "/x/dist/cli.mjs").args).toEqual([
      "/x/dist/cli.mjs",
    ]);
    expect(spawnViaNodeIfScript("/x/bin/b", () => "/x/dist/cli.cjs").args).toEqual([
      "/x/dist/cli.cjs",
    ]);
  });

  it("leaves a NON-script launcher alone — handing a native binary to node would break it", () => {
    const native = "/opt/tools/some-native-launcher";
    expect(spawnViaNodeIfScript(native, () => native)).toEqual({
      command: native,
      args: [],
    });
    // Windows .cmd shims are their own interpreter too.
    expect(spawnViaNodeIfScript("C:\\x\\a.cmd", (p) => p)).toEqual({
      command: "C:\\x\\a.cmd",
      args: [],
    });
  });

  it("falls back to the original path when realpath throws (broken/unreadable link)", () => {
    expect(
      spawnViaNodeIfScript("/x/bin/a", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ command: "/x/bin/a", args: [] });
  });
});
