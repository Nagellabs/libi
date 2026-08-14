import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────
// The route composes: user-codex detection (→ available), a LIVE
// `codex mcp list` probe (→ installed), the settings helpers (persist/read
// last status), and the sync layer (syncCodexGlobalMcps /
// disconnectCodexGlobalMcps). All are mocked so the test exercises ONLY the
// route's compose logic. Worktree-safety is NOT a route concern anymore — it
// lives in resolveCodexHome (writes target a scoped home), so there is no
// canonical gate here.

vi.mock("@/lib/codex-config/canonical", () => ({
  resolveCodexHome: () => "/fake/codex/home",
}));

const probeInstalledServers = vi.fn<
  (opts?: { bin?: string }) => Promise<string[] | null>
>(async () => ["libi"]);
// The route's availability gate is `userCodexCli()` — "does the PERSON have
// codex" — NOT the agent registry's `installed` flag (which since the
// detectCodex fix means "the bundled ACP adapter can run": embedded engine,
// PATH never consulted), and NOT a bare PATH probe (which sees libi's own
// `node_modules/.bin/codex` shim).
type CodexCliSource =
  | { kind: "user"; path: string }
  | { kind: "libi-internal"; path: string }
  | { kind: "none" };
const userCodexCli = vi.fn<() => CodexCliSource>(() => ({
  kind: "user",
  path: "/opt/homebrew/bin/codex",
}));
const mcpAdd = vi.fn(async () => ({ ok: true as const, stdout: "" }));
const mcpRemove = vi.fn(async () => ({ ok: true as const, stdout: "" }));
vi.mock("@/lib/codex-config/codex-cli", () => ({
  probeInstalledServers: (opts?: { bin?: string }) => probeInstalledServers(opts),
  userCodexCli: () => userCodexCli(),
  mcpAdd: () => mcpAdd(),
  mcpRemove: () => mcpRemove(),
}));

// libi's sidecar record of the names IT wrote. Used as the fallback answer for
// "are libi entries present" when there is no codex binary to ask, and to name
// the exact blocks in the manual-cleanup refusal.
const readManagedNames = vi.fn<() => Set<string>>(() => new Set<string>());
vi.mock("@/lib/codex-config/managed-manifest", () => ({
  readManagedNames: () => readManagedNames(),
}));

const getCodexConnectSetting = vi.fn(() => ({
  connected: false,
  lastSyncStatus: "idle" as "ok" | "error" | "idle",
}));
const setCodexConnectSetting = vi.fn();
vi.mock("@/lib/db/settings", () => ({
  getCodexConnectSetting: () => getCodexConnectSetting(),
  setCodexConnectSetting: (s: unknown) => setCodexConnectSetting(s),
}));

// Deps are forwarded (not dropped) so tests can assert the route pins the
// codex binary it resolved instead of letting the sync layer re-resolve `codex`
// against this process's PATH.
const syncCodexGlobalMcps = vi.fn<(deps?: unknown) => Promise<void>>(async () => {});
const disconnectCodexGlobalMcps = vi.fn<(deps?: unknown) => Promise<void>>(
  async () => {},
);
vi.mock("@/lib/codex-config/sync", () => ({
  syncCodexGlobalMcps: (d?: unknown) => syncCodexGlobalMcps(d),
  disconnectCodexGlobalMcps: (d?: unknown) => disconnectCodexGlobalMcps(d),
}));

function makePost(body: unknown): Request {
  return new Request("http://localhost/api/codex/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  userCodexCli.mockReturnValue({ kind: "user", path: "/opt/homebrew/bin/codex" });
  probeInstalledServers.mockResolvedValue(["libi"]);
  readManagedNames.mockReturnValue(new Set<string>());
  getCodexConnectSetting.mockReturnValue({ connected: false, lastSyncStatus: "idle" });
});

describe("GET /api/codex/connect", () => {
  it("returns available:false + reason when the user has no codex", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.available).toBe(false);
    expect(json.installed).toBe(false);
    expect(json.reason).toBe("codex_not_installed");
  });

  it("does NOT probe codex when the user has none", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    const { GET } = await import("@/app/api/codex/connect/route");
    await (await GET()).json();
    expect(probeInstalledServers).not.toHaveBeenCalled();
  });

  it("reports installed:true (live) when the libi server is present", async () => {
    getCodexConnectSetting.mockReturnValue({ connected: true, lastSyncStatus: "ok" });
    probeInstalledServers.mockResolvedValue(["libi", "fal-ai"]);
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json).toMatchObject({ available: true, installed: true, status: "ok" });
    expect(json.reason).toBeNull();
  });

  it("returns the config path (for the Open config button); configExists reflects disk", async () => {
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    // resolveCodexHome is mocked to /fake/codex/home, which doesn't exist.
    expect(json.codexHome).toBe("/fake/codex/home");
    expect(json.configPath).toBe("/fake/codex/home/config.toml");
    expect(json.configExists).toBe(false);
  });

  it("reports installed:false when libi is absent from the codex config", async () => {
    probeInstalledServers.mockResolvedValue(["some-other-server"]);
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.installed).toBe(false);
  });

  // THE BUG: a `codex` that exists only inside libi's own tree (npm puts
  // `<repo>/node_modules/.bin` on the dev server's PATH) is NOT the user's.
  // Reporting it as available lit up Install, which really wrote
  // ~/.codex/config.toml for a binary the user can never invoke.
  it("reports available:false for a libi-internal codex", async () => {
    userCodexCli.mockReturnValue({
      kind: "libi-internal",
      path: "/repo/node_modules/.bin/codex",
    });
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.available).toBe(false);
    expect(json.cliSource).toBe("libi-internal");
    expect(json.installed).toBe(false);
  });

  // THE STRANDING: the entries the old probe wrote are really in the config
  // while the user has no codex of their own. `installed` cannot express that
  // (it is gated on `available`), which is what made the state invisible and
  // the entries unremovable.
  it("reports libiEntriesPresent:true for a libi-internal codex even though available:false", async () => {
    userCodexCli.mockReturnValue({
      kind: "libi-internal",
      path: "/repo/node_modules/.bin/codex",
    });
    probeInstalledServers.mockResolvedValue(["libi", "YouTube-Downloader"]);
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.available).toBe(false);
    expect(json.installed).toBe(false);
    expect(json.libiEntriesPresent).toBe(true);
    // Asked through the binary we actually resolved, not a bare `codex`.
    expect(probeInstalledServers).toHaveBeenCalledWith({
      bin: "/repo/node_modules/.bin/codex",
    });
  });

  it("falls back to libi's manifest for libiEntriesPresent when there is no codex at all", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    readManagedNames.mockReturnValue(new Set(["libi", "YouTube-Downloader"]));
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.libiEntriesPresent).toBe(true);
    expect(probeInstalledServers).not.toHaveBeenCalled();
  });

  it("libiEntriesPresent:false when nothing was ever written and no codex exists", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    readManagedNames.mockReturnValue(new Set());
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.libiEntriesPresent).toBe(false);
  });

  it("carries cliSource + the install remedy when the user has no codex", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.cliSource).toBe("none");
    expect(json.remedy).toMatchObject({
      label: expect.any(String),
      command: expect.any(String),
      detail: expect.any(String),
    });
  });

  it("cliSource:'user' and no remedy when the user really has codex", async () => {
    const { GET } = await import("@/app/api/codex/connect/route");
    const json = await (await GET()).json();
    expect(json.cliSource).toBe("user");
    expect(json.remedy).toBeNull();
  });
});

describe("POST /api/codex/connect", () => {
  it("connected:true persists + calls syncCodexGlobalMcps once", async () => {
    probeInstalledServers.mockResolvedValue(["libi"]);
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: true }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.installed).toBe(true);
    expect(setCodexConnectSetting).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true }),
    );
    expect(syncCodexGlobalMcps).toHaveBeenCalledTimes(1);
    expect(disconnectCodexGlobalMcps).not.toHaveBeenCalled();
  });

  it("connected:false calls disconnectCodexGlobalMcps, not sync", async () => {
    probeInstalledServers.mockResolvedValue([]);
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.installed).toBe(false);
    expect(setCodexConnectSetting).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false }),
    );
    expect(disconnectCodexGlobalMcps).toHaveBeenCalledTimes(1);
    expect(syncCodexGlobalMcps).not.toHaveBeenCalled();
  });

  it("returns 409 available:false and runs NO sync when the user has no codex", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: true }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(setCodexConnectSetting).not.toHaveBeenCalled();
    expect(syncCodexGlobalMcps).not.toHaveBeenCalled();
    expect(disconnectCodexGlobalMcps).not.toHaveBeenCalled();
  });

  // ── The gate is DIRECTIONAL ────────────────────────────────────────
  // Connect writes config for a binary (must be theirs). Disconnect removes
  // libi's OWN manifest-listed names (pure cleanup, can't damage anything) —
  // so refusing it because the binary "isn't theirs" would strand every user
  // who clicked Install under the old buggy probe.

  it("connected:false SUCCEEDS with a libi-internal codex and cleans up", async () => {
    userCodexCli.mockReturnValue({
      kind: "libi-internal",
      path: "/repo/node_modules/.bin/codex",
    });
    probeInstalledServers.mockResolvedValue([]);
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.libiEntriesPresent).toBe(false);
    expect(json.cliSource).toBe("libi-internal");
    expect(disconnectCodexGlobalMcps).toHaveBeenCalledTimes(1);
    expect(syncCodexGlobalMcps).not.toHaveBeenCalled();
    expect(setCodexConnectSetting).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false }),
    );
  });

  it("pins the resolved binary into the sync layer instead of re-resolving `codex`", async () => {
    userCodexCli.mockReturnValue({
      kind: "libi-internal",
      path: "/repo/node_modules/.bin/codex",
    });
    const { POST } = await import("@/app/api/codex/connect/route");
    await POST(makePost({ connected: false }));
    const deps = disconnectCodexGlobalMcps.mock.calls[0]?.[0] as
      | { cli?: { mcpRemove?: unknown } }
      | undefined;
    expect(typeof deps?.cli?.mcpRemove).toBe("function");
  });

  // An honest dead end beats a false success — the same class of lie as the
  // original bug. Name the file and the exact blocks libi wrote.
  it("connected:false with NO codex anywhere refuses, naming the config + blocks", async () => {
    userCodexCli.mockReturnValue({ kind: "none" });
    readManagedNames.mockReturnValue(new Set(["libi", "YouTube-Downloader"]));
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: false }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("manual_cleanup_required");
    expect(json.configPath).toBe("/fake/codex/home/config.toml");
    expect(json.managedNames).toEqual(["YouTube-Downloader", "libi"]);
    expect(json.message).toContain("[mcp_servers.libi]");
    expect(json.message).toContain("/fake/codex/home/config.toml");
    // Refusal means refusal: no state change, no half-done cleanup.
    expect(setCodexConnectSetting).not.toHaveBeenCalled();
    expect(disconnectCodexGlobalMcps).not.toHaveBeenCalled();
  });

  // Writing a real config for libi's own in-tree codex IS the reported bug —
  // the install succeeds and provisions a binary the user can never invoke.
  it("returns 409 and runs NO sync for a libi-internal codex", async () => {
    userCodexCli.mockReturnValue({
      kind: "libi-internal",
      path: "/repo/node_modules/.bin/codex",
    });
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: true }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(json.cliSource).toBe("libi-internal");
    expect(json.remedy).toMatchObject({ command: expect.any(String) });
    expect(setCodexConnectSetting).not.toHaveBeenCalled();
    expect(syncCodexGlobalMcps).not.toHaveBeenCalled();
    expect(disconnectCodexGlobalMcps).not.toHaveBeenCalled();
  });

  it("runs the install on a worktree/non-canonical instance (no canonical gate)", async () => {
    // codex on PATH is the only precondition; resolveCodexHome handles safety.
    probeInstalledServers.mockResolvedValue(["libi"]);
    const { POST } = await import("@/app/api/codex/connect/route");
    const res = await POST(makePost({ connected: true }));
    expect(res.status).toBe(200);
    expect(syncCodexGlobalMcps).toHaveBeenCalledTimes(1);
  });
});
