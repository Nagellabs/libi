/**
 * The Whisper card is satisfied by ANY installed Whisper model.
 *
 * 0.1.16 full verification F8: after a working `tiny` install (a real
 * transcript came back) the card still said "Setup required", because its
 * model chip was hardcoded to "whisper small weights".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A uv on the developer's PATH must not decide the uv chip.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      if (typeof cmd === "string" && /^(which|where)\s/.test(cmd)) throw new Error("not found");
      return (actual.execSync as unknown as (...args: unknown[]) => Buffer)(cmd, ...rest);
    },
  };
});

import { GET } from "@/app/api/settings/mcp-servers/[id]/dependencies/route";
import { UV_DEPENDENCY } from "@/mcp/registry/bundled";
import { deriveAggregateStatus } from "@/lib/settings/aggregate-status";
import { writeWhisperEnvToken } from "@/lib/whisper/transcribe";
import { hfCacheDirName, whisperModelsDir } from "@/lib/whisper/models";
import type { DependencyStatus } from "@/lib/queries/mcp-servers";

const savedHome = process.env.LIBI_HOME;
let home: string;

function installModel(model: string) {
  const rev = path.join(whisperModelsDir(), hfCacheDirName(model), "snapshots", "abc123");
  fs.mkdirSync(rev, { recursive: true });
  fs.writeFileSync(path.join(rev, "model.bin"), "weights");
}

async function whisperDeps(): Promise<DependencyStatus[]> {
  const res = await GET(new Request("http://localhost/api/settings/mcp-servers/whisper/dependencies"), {
    params: Promise.resolve({ id: "whisper" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { dependencies: DependencyStatus[] }).dependencies;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-card-"));
  process.env.LIBI_HOME = home;
  // uv on disk with its current token — both spellings, whatever the host.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["uv", "uv.exe"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.install-token`), UV_DEPENDENCY.pinnedInstallToken ?? "");
  }
  writeWhisperEnvToken();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("GET /api/settings/mcp-servers/whisper/dependencies", () => {
  it("with only `tiny` installed, the card is ready", async () => {
    installModel("tiny");
    const deps = await whisperDeps();
    const model = deps.find((d) => d.binary === "a Whisper model");
    expect(model).toMatchObject({ installed: true, runtimeStatus: "installed" });
    expect(deriveAggregateStatus(deps)).toBe("installed");
  });

  it("any other single model counts too", async () => {
    installModel("large-v3");
    expect(deriveAggregateStatus(await whisperDeps())).toBe("installed");
  });

  it("with no model at all, the model chip is pending", async () => {
    const deps = await whisperDeps();
    expect(deps.find((d) => d.binary === "a Whisper model")).toMatchObject({
      installed: false,
      runtimeStatus: "pending",
    });
    expect(deriveAggregateStatus(deps)).toBe("pending");
  });

  it("an empty snapshot folder is not a model", async () => {
    fs.mkdirSync(path.join(whisperModelsDir(), hfCacheDirName("tiny"), "snapshots", "abc123"), {
      recursive: true,
    });
    expect(deriveAggregateStatus(await whisperDeps())).toBe("pending");
  });
});
