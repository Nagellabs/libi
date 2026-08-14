import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServerEntry } from "@/lib/mcp-config";
import type { SyncDeps } from "@/lib/codex-config/sync";
import {
  syncCodexGlobalMcps,
  disconnectCodexGlobalMcps,
  syncCodexGlobalMcpsIfConnected,
} from "@/lib/codex-config/sync";

// The settings helpers are the only real-DB dependency the sync layer reaches
// for on its own. Mock them so tests can control `connected` and observe the
// persisted `lastSyncStatus`.
let connectState = { connected: false, lastSyncStatus: "idle" as "ok" | "error" | "idle" };
const setCalls: Array<{ connected: boolean; lastSyncStatus: string }> = [];

vi.mock("@/lib/db/settings", () => ({
  getCodexConnectSetting: () => connectState,
  setCodexConnectSetting: (s: { connected: boolean; lastSyncStatus: "ok" | "error" | "idle" }) => {
    setCalls.push(s);
    connectState = s;
  },
}));

const OK = { ok: true as const, stdout: "" };

function stdioEntry(cmd: string): McpServerEntry {
  return { command: cmd };
}

/** Build a fake deps object that records every cli/manifest call. */
function makeFakeDeps(opts: {
  desired: Record<string, McpServerEntry>;
  manifestNames: string[];
  isCanonical?: boolean;
  libiHome?: string;
  addResult?: (name: string) => { ok: boolean };
  removeResult?: (name: string) => { ok: boolean };
}) {
  const record = {
    adds: [] as string[],
    addedEntries: {} as Record<string, McpServerEntry>,
    removes: [] as string[],
    manifestWrites: [] as string[][],
    codexHomeSeen: [] as (string | undefined)[],
  };
  let managed = new Set(opts.manifestNames);

  const deps: SyncDeps = {
    codexHome: "/fake/codex/home",
    libiHome: opts.libiHome ?? "/fake/libi/home",
    isCanonical: () => opts.isCanonical ?? true,
    getEntries: () => opts.desired,
    cli: {
      mcpAdd: async (name, entry, cliOpts) => {
        record.adds.push(name);
        record.addedEntries[name] = entry;
        record.codexHomeSeen.push(cliOpts?.codexHome);
        const r = opts.addResult?.(name) ?? { ok: true };
        return r.ok ? OK : { ok: false, stderr: "add failed" };
      },
      mcpRemove: async (name, cliOpts) => {
        record.removes.push(name);
        record.codexHomeSeen.push(cliOpts?.codexHome);
        const r = opts.removeResult?.(name) ?? { ok: true };
        return r.ok ? OK : { ok: false, stderr: "remove failed" };
      },
    },
    manifest: {
      readManagedNames: () => new Set(managed),
      writeManagedNames: (_home, names) => {
        managed = new Set(names);
        record.manifestWrites.push([...names].sort());
      },
    },
  };

  return { deps, record, getManaged: () => managed };
}

describe("syncCodexGlobalMcps", () => {
  beforeEach(() => {
    connectState = { connected: true, lastSyncStatus: "idle" };
    setCalls.length = 0;
  });

  it("(a) diffs desired {a,b} vs manifest {a,c}: adds a,b; removes c; rewrites manifest to {a,b}", async () => {
    const { deps, record, getManaged } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd"), b: stdioEntry("b-cmd") },
      manifestNames: ["a", "c"],
    });

    await syncCodexGlobalMcps(deps);

    // Every desired entry is added (add-or-update).
    expect(record.adds.sort()).toEqual(["a", "b"]);
    // Only manifest-orphan c is removed (not in desired).
    expect(record.removes).toEqual(["c"]);
    // Manifest rewritten to the desired names.
    expect([...getManaged()].sort()).toEqual(["a", "b"]);
    expect(record.manifestWrites.at(-1)).toEqual(["a", "b"]);
    // CODEX_HOME threaded to the cli calls.
    expect(record.codexHomeSeen.every((h) => h === "/fake/codex/home")).toBe(true);
    // Success → lastSyncStatus ok.
    expect(setCalls.at(-1)).toEqual({ connected: true, lastSyncStatus: "ok" });
  });

  it("(f) removal only targets manifest names not in desired — never a name absent from the manifest", async () => {
    // desired {a}; manifest has a libi-owned orphan `libi-old` plus user server `user-x` is NOT in the manifest.
    const { deps, record } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: ["a", "libi-old"],
    });

    await syncCodexGlobalMcps(deps);

    // Only libi-old (in manifest, not desired) is removed. user-x never touched.
    expect(record.removes).toEqual(["libi-old"]);
    expect(record.removes).not.toContain("user-x");
    expect(record.adds).toEqual(["a"]);
  });

  it("(e) a {ok:false} from cli marks lastSyncStatus 'error' and does NOT throw", async () => {
    const { deps } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: [],
      addResult: () => ({ ok: false }),
    });

    await expect(syncCodexGlobalMcps(deps)).resolves.toBeUndefined();
    expect(setCalls.at(-1)).toEqual({ connected: true, lastSyncStatus: "error" });
  });

  it("a {ok:false} from a remove call also marks 'error'", async () => {
    const { deps } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: ["a", "gone"],
      removeResult: () => ({ ok: false }),
    });

    await syncCodexGlobalMcps(deps);
    expect(setCalls.at(-1)).toEqual({ connected: true, lastSyncStatus: "error" });
  });

  it("sanitizes codex-invalid server names (spaces) instead of dropping them", async () => {
    const { deps, record, getManaged } = makeFakeDeps({
      desired: {
        libi: stdioEntry("tsx"),
        "YouTube Downloader": stdioEntry("npx"),
      },
      manifestNames: [],
    });

    await syncCodexGlobalMcps(deps);

    // "YouTube Downloader" is installed under a codex-valid name, not skipped.
    expect(record.adds.sort()).toEqual(["YouTube-Downloader", "libi"]);
    expect(record.addedEntries).toHaveProperty("YouTube-Downloader");
    // Manifest tracks the sanitized name actually written to the config.
    expect([...getManaged()].sort()).toEqual(["YouTube-Downloader", "libi"]);
  });

  it("keeps a bundled MCP's own required key (ElevenLabs) but drops unrelated secrets", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-el");
    vi.stubEnv("FAL_KEY", "sk-fal");
    try {
      const { deps, record } = makeFakeDeps({
        desired: {
          ElevenLabs: {
            command: "npx",
            env: {
              ELEVENLABS_API_KEY: "sk-el", // required by ElevenLabs — kept
              FAL_KEY: "sk-fal", // another service's secret — dropped
              PATH: "/p",
            },
          },
        },
        manifestNames: [],
        libiHome: "/h",
      });

      await syncCodexGlobalMcps(deps);

      const el = record.addedEntries["ElevenLabs"] as {
        env?: Record<string, string>;
      };
      expect(el.env?.ELEVENLABS_API_KEY).toBe("sk-el");
      expect(el.env).not.toHaveProperty("FAL_KEY");
      expect(el.env?.LIBI_HOME).toBe("/h");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pins LIBI_HOME into every stdio entry so the codex-spawned MCP child reads this app's home", async () => {
    const { deps, record } = makeFakeDeps({
      desired: {
        libi: { command: "tsx", args: ["mcp/index.ts"] },
        "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp" },
      },
      manifestNames: [],
      libiHome: "/Users/me/.libi/worktrees/wt",
    });

    await syncCodexGlobalMcps(deps);

    // stdio libi entry carries LIBI_HOME (preserving any pre-existing env).
    const libi = record.addedEntries["libi"] as {
      env?: Record<string, string>;
    };
    expect(libi.env?.LIBI_HOME).toBe("/Users/me/.libi/worktrees/wt");
    // HTTP entries are unchanged (no env pinned).
    expect(record.addedEntries["fal-ai"]).not.toHaveProperty("env");
  });

  it("writes a SECRET-FREE env: keeps PATH + MCP-declared vars, drops inherited process-env keys", async () => {
    // Simulate an inherited secret already present in this process's env.
    vi.stubEnv("LIBI_TEST_INHERITED_SECRET", "supersecret");
    try {
      const { deps, record } = makeFakeDeps({
        desired: {
          libi: {
            command: "tsx",
            env: {
              PATH: "/libi/bin:/usr/bin", // augmented PATH — kept (allowlist)
              HOME: "/Users/me", // non-secret operational var — kept (allowlist)
              LIBI_TEST_INHERITED_SECRET: "supersecret", // inherited — dropped
              MCP_DECLARED_XZ: "keep-me", // declared (not in process.env) — kept
            },
          },
        },
        manifestNames: [],
        libiHome: "/home/x",
      });

      await syncCodexGlobalMcps(deps);

      const libi = record.addedEntries["libi"] as {
        env?: Record<string, string>;
      };
      expect(libi.env).toEqual({
        PATH: "/libi/bin:/usr/bin",
        HOME: "/Users/me",
        MCP_DECLARED_XZ: "keep-me",
        LIBI_HOME: "/home/x",
      });
      expect(libi.env).not.toHaveProperty("LIBI_TEST_INHERITED_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still rewrites the manifest even when a cli call failed", async () => {
    const { deps, getManaged } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd"), b: stdioEntry("b-cmd") },
      manifestNames: ["c"],
      addResult: (n) => ({ ok: n !== "b" }),
    });

    await syncCodexGlobalMcps(deps);
    expect([...getManaged()].sort()).toEqual(["a", "b"]);
  });
});

describe("disconnectCodexGlobalMcps", () => {
  beforeEach(() => {
    connectState = { connected: true, lastSyncStatus: "ok" };
    setCalls.length = 0;
  });

  it("(b) removes every manifest name and empties the manifest", async () => {
    const { deps, record, getManaged } = makeFakeDeps({
      desired: {},
      manifestNames: ["a", "b", "c"],
    });

    await disconnectCodexGlobalMcps(deps);

    expect(record.removes.sort()).toEqual(["a", "b", "c"]);
    expect([...getManaged()]).toEqual([]);
    expect(record.manifestWrites.at(-1)).toEqual([]);
    // No adds happen on disconnect.
    expect(record.adds).toEqual([]);
  });

  it("does not throw when a remove fails", async () => {
    const { deps, getManaged } = makeFakeDeps({
      desired: {},
      manifestNames: ["a"],
      removeResult: () => ({ ok: false }),
    });

    await expect(disconnectCodexGlobalMcps(deps)).resolves.toBeUndefined();
    expect([...getManaged()]).toEqual([]);
  });
});

describe("syncCodexGlobalMcpsIfConnected", () => {
  beforeEach(() => {
    setCalls.length = 0;
  });

  it("(c) makes ZERO cli calls when connected=false", async () => {
    connectState = { connected: false, lastSyncStatus: "idle" };
    const { deps, record } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: ["b"],
      isCanonical: true,
    });

    await syncCodexGlobalMcpsIfConnected(deps);

    expect(record.adds).toEqual([]);
    expect(record.removes).toEqual([]);
    expect(record.manifestWrites).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it("(d) makes ZERO cli calls when isCanonical()=false EVEN IF connected=true (worktree-safety)", async () => {
    connectState = { connected: true, lastSyncStatus: "ok" };
    const { deps, record } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: ["b"],
      isCanonical: false,
    });

    await syncCodexGlobalMcpsIfConnected(deps);

    // Guard wins — the fake cli recorded nothing.
    expect(record.adds).toEqual([]);
    expect(record.removes).toEqual([]);
    expect(record.manifestWrites).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it("delegates to syncCodexGlobalMcps when connected AND canonical", async () => {
    connectState = { connected: true, lastSyncStatus: "idle" };
    const { deps, record } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: [],
      isCanonical: true,
    });

    await syncCodexGlobalMcpsIfConnected(deps);

    expect(record.adds).toEqual(["a"]);
    expect(setCalls.at(-1)).toEqual({ connected: true, lastSyncStatus: "ok" });
  });

  it("never throws even if a cli call fails while connected+canonical", async () => {
    connectState = { connected: true, lastSyncStatus: "idle" };
    const { deps } = makeFakeDeps({
      desired: { a: stdioEntry("a-cmd") },
      manifestNames: [],
      isCanonical: true,
      addResult: () => ({ ok: false }),
    });

    await expect(syncCodexGlobalMcpsIfConnected(deps)).resolves.toBeUndefined();
  });
});
