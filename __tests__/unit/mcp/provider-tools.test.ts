import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `notify` is an EMPTY object on purpose: the in-app answer is a card the chat
// renders from the tool result, so nothing here may POST to the studio — any
// notify call would throw on the missing method and fail the test that made it.
// `studioBaseUrl` is fixed so the CLI answer's Agents page URLs are assertable
// (and can be made to report "no studio port known").
const STUDIO_BASE = "http://127.0.0.1:3461";
const { trackMcpEvent, fetchProviders, studioBaseUrl } = vi.hoisted(() => ({
  trackMcpEvent: vi.fn(),
  studioBaseUrl: vi.fn((): string | null => "http://127.0.0.1:3461"),
  fetchProviders: vi.fn(async () => [
    { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
  ]),
}));
vi.mock("@/mcp/notify", () => ({ notify: {}, studioBaseUrl }));
vi.mock("@/mcp/analytics", () => ({ trackMcpEvent }));
vi.mock("@/mcp/tools/provider-http", () => ({ fetchConnectedProviders: fetchProviders }));

// Coverage is a claim about the MACHINE, so both tools now re-derive each
// catalogued extension's status from disk before reading it (QA: a Whisper
// model the user had already downloaded kept being offered, because nothing
// called `libi.update_dep_status` and the stored field stayed `pending`).
// `settleInstallStatus` is the real prober; here it is a fake standing in for
// what the disk says, defaulting to "the row is already right".
const { settleInstallStatus } = vi.hoisted(() => ({
  settleInstallStatus: vi.fn(async (_id: string): Promise<string | null> => null),
}));
vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    settleInstallStatus = settleInstallStatus;
  },
}));

import { sql } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { suggestProvider, listProviders } from "@/mcp/tools/provider-tools";

/** The libi-owned rows the table holds since migration 0051 — nothing else. */
function seedLibiRows() {
  getDb()
    .insert(mcpServers)
    .values([
      { id: "libi", name: "Libi", description: "libi's own tools", type: "stdio", command: "node", args: "[]", envVars: JSON.stringify({ SECRET: "hush" }), bundled: true, installStatus: "installed", dependencyStatus: "[]" },
      { id: "local-music", name: "Local Music (ACE-Step)", description: "Music on-device", type: "stdio", command: "node", args: "[]", bundled: true, installStatus: "pending", dependencyStatus: "[]" },
      { id: "whisper", name: "Whisper (local STT)", description: "Transcribe locally", type: "stdio", command: "node", args: "[]", bundled: true, installStatus: "installed", dependencyStatus: "[]" },
    ])
    .run();
}

beforeEach(() => {
  createTestDb();
  trackMcpEvent.mockClear();
  fetchProviders.mockClear();
  settleInstallStatus.mockClear();
  settleInstallStatus.mockImplementation(async () => null);
  studioBaseUrl.mockReset();
  studioBaseUrl.mockImplementation(() => STUDIO_BASE);
});

afterEach(() => resetTestDb());

describe("libi.suggest_provider", () => {
  it("in-app: returns a card payload, on-device first, and touches no notify path", async () => {
    const res = await suggestProvider({ kind: "music" }, { surface: "in-app" });
    const data = res.data as {
      status: string;
      connected: unknown[];
      covered: unknown[];
      suggested: Array<{ id: string; kind: string; extensionId?: string; sizeNote?: string; name: string; kinds: string[] }>;
    };
    expect(data.status).toBe("card");
    // The card still hands back what the agent already has: fal-ai is connected
    // (the hoisted detection default) but covers image/video, not music.
    expect(data.connected).toEqual([
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
    ]);
    expect(data.covered).toEqual([]);
    expect(data.suggested.map((s) => s.id)).toEqual(["ace-step", "elevenlabs"]);
    expect(data.suggested[0]).toMatchObject({ kind: "extension", extensionId: "local-music", name: "ACE-Step (on-device music)" });
    expect(data.suggested[0].sizeNote).toMatch(/GB/);
    expect(data.suggested[1]).toMatchObject({ kind: "remote-mcp", id: "elevenlabs" });
    expect(JSON.stringify(data)).not.toMatch(/<your key>|commands/);
  });

  it("in-app: a connected provider for the kind is reported as covered on the card, not offered", async () => {
    const data = (await suggestProvider({ kind: "image" }, { surface: "in-app" })).data as {
      status: string;
      covered: unknown[];
      suggested: Array<{ id: string }>;
    };
    expect(data.status).toBe("card");
    expect(data.covered).toEqual([{ id: "fal", name: "fal.ai", via: "connected" }]);
    expect(data.suggested.map((s) => s.id)).toEqual(["higgsfield"]);
  });

  it("returns status cli with the same payload on a CLI", async () => {
    // Nothing connected here: the connected-provider subtraction is its own
    // case, tested below.
    fetchProviders.mockResolvedValueOnce([]);
    const res = await suggestProvider({ kind: "video", reason: "user asked for a clip" }, { surface: "cli" });
    expect(res.success).toBe(true);
    expect((res.data as { status: string }).status).toBe("cli");
    expect((res.data as { suggested: string[] }).suggested).toEqual(["fal", "higgsfield"]);
  });

  it("includes the exact add command text for the CLI surface", async () => {
    fetchProviders.mockResolvedValueOnce([]);
    const res = await suggestProvider({ kind: "video" }, { surface: "cli" });
    expect(JSON.stringify(res.data)).toContain("<your key>");
    expect(JSON.stringify(res.data)).toContain("claude mcp add --scope user --transport http fal-ai");
  });

  it("still answers when detection fails", async () => {
    fetchProviders.mockRejectedValueOnce(new Error("server down"));
    const res = await suggestProvider({ kind: "voice" }, { surface: "in-app" });
    expect(res.success).toBe(true);
    expect((res.data as { connected: unknown[] }).connected).toEqual([]);
  });

  it("cli: Higgsfield's option says it signs in with an account, carries each agent's sign-in command, and has no key", async () => {
    fetchProviders.mockResolvedValueOnce([]);
    const data = (await suggestProvider({ kind: "video" }, { surface: "cli" })).data as {
      note: string;
      options: Array<Record<string, unknown>>;
    };
    const hf = data.options.find((o) => o.id === "higgsfield")!;
    expect(hf).toMatchObject({
      auth: "oauth",
      docsUrl: "https://higgsfield.ai/mcp",
      commands: {
        claude: "claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp",
        codex: "codex mcp add higgsfield --url https://mcp.higgsfield.ai/mcp",
      },
      signInCommands: { claude: "claude mcp login higgsfield", codex: "codex mcp login higgsfield" },
    });
    expect(JSON.stringify(hf)).not.toContain("<your key>");
    const falOption = data.options.find((o) => o.id === "fal")!;
    expect(falOption).not.toHaveProperty("auth");
    expect(falOption).not.toHaveProperty("signInCommands");
    expect(data.note).toContain('auth: "oauth"');
    expect(data.note).toContain("<your key>");
  });

  it("in-app: a Higgsfield entry that still needs signing in is offered again, not reported as covered", async () => {
    fetchProviders.mockResolvedValueOnce([
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" },
    ]);
    const data = (await suggestProvider({ kind: "video" }, { surface: "in-app" })).data as {
      covered: unknown[];
      suggested: Array<{ id: string }>;
    };
    expect(data.suggested.map((s) => s.id)).toEqual(["fal", "higgsfield"]);
    expect(data.covered).toEqual([]);
  });

  it("cli: keeps the commands and adds an Agents page URL per option on the 127.0.0.1 base", async () => {
    // The file's hoisted fetchProviders default reports fal-ai CONNECTED, which moves fal into
    // `covered` — so every CLI call here starts from an empty detection, like the other CLI cases above.
    fetchProviders.mockResolvedValueOnce([]);
    const res = await suggestProvider({ kind: "video" }, { surface: "cli" });
    const data = res.data as { status: string; options: Array<{ id: string; agentsPageUrl: string; commands?: unknown }> };
    expect(data.status).toBe("cli");
    expect(data.options.find((o) => o.id === "fal")!.agentsPageUrl).toBe("http://127.0.0.1:3461/agents?tab=providers&provider=fal");
    fetchProviders.mockResolvedValueOnce([]);
    const music = (await suggestProvider({ kind: "music" }, { surface: "cli" })).data as { options: Array<{ id: string; agentsPageUrl: string }> };
    expect(music.options.find((o) => o.id === "ace-step")!.agentsPageUrl).toBe("http://127.0.0.1:3461/agents?tab=libi-mcp&extension=local-music");
    // Every option's URL is built on studioBaseUrl(), nothing else.
    for (const o of data.options) expect(o.agentsPageUrl.startsWith(`${STUDIO_BASE}/agents?`), o.id).toBe(true);
  });

  it("cli: a session that knows its agent opens the Providers tab on that agent; an extension's URL is unchanged", async () => {
    for (const [dialect, expected] of [["codex", "codex"], ["claude", "claude-code"]] as const) {
      fetchProviders.mockResolvedValueOnce([]);
      const data = (await suggestProvider({ kind: "video" }, { surface: "cli", dialect })).data as {
        options: Array<{ id: string; agentsPageUrl: string }>;
      };
      expect(data.options.find((o) => o.id === "fal")!.agentsPageUrl, dialect).toBe(
        `http://127.0.0.1:3461/agents?tab=providers&provider=fal&setupAgent=${expected}`,
      );
    }
    fetchProviders.mockResolvedValueOnce([]);
    const music = (await suggestProvider({ kind: "music" }, { surface: "cli", dialect: "codex" })).data as {
      options: Array<{ id: string; agentsPageUrl: string }>;
    };
    expect(music.options.find((o) => o.id === "ace-step")!.agentsPageUrl).toBe("http://127.0.0.1:3461/agents?tab=libi-mcp&extension=local-music");
  });

  it("cli: omits agentsPageUrl when no studio port is known, and keeps the commands", async () => {
    fetchProviders.mockResolvedValueOnce([]);
    studioBaseUrl.mockReturnValue(null);
    const data = (await suggestProvider({ kind: "video" }, { surface: "cli" })).data as {
      status: string;
      options: Array<Record<string, unknown>>;
    };
    expect(data.status).toBe("cli");
    expect(data.options.map((o) => o.id)).toEqual(["fal", "higgsfield"]);
    for (const o of data.options) expect(o, String(o.id)).not.toHaveProperty("agentsPageUrl");
    // …while the add command itself is unaffected.
    expect(JSON.stringify(data.options.find((o) => o.id === "fal"))).toContain("claude mcp add --scope user --transport http fal-ai");
  });

  // The card's whole job is "you lack a provider for this kind, here is
  // how to add one". Offering one the user already runs is noise; offering the
  // on-device model that just answered the call (transcription → Whisper) is
  // wrong. So what is already usable is subtracted from `suggested` and
  // reported separately as `covered`.
  describe("what the agent already has", () => {
    it("drops a connected provider from suggested and reports it as covered", async () => {
      // fetchProviders returns fal-ai connected; fal is an `image` provider.
      const res = await suggestProvider({ kind: "image" }, { surface: "cli" });
      const data = res.data as {
        suggested: string[];
        covered: Array<{ id: string; via: string }>;
        options: Array<{ id: string }>;
      };
      expect(data.suggested).toEqual(["higgsfield"]);
      expect(data.covered).toEqual([{ id: "fal", name: "fal.ai", via: "connected" }]);
      // …and the CLI command list follows `suggested`, not the catalog.
      expect(data.options.map((o) => o.id)).toEqual(["higgsfield"]);
    });

    it("keeps a provider whose entry has no key — the add command is what fixes it", async () => {
      fetchProviders.mockResolvedValueOnce([
        { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "needs-key" },
      ]);
      const data = (await suggestProvider({ kind: "image" }, { surface: "cli" })).data as {
        suggested: string[];
        covered: unknown[];
      };
      expect(data.suggested).toEqual(["fal", "higgsfield"]);
      expect(data.covered).toEqual([]);
    });

    it("counts an INSTALLED libi extension as covering its kind", async () => {
      seedLibiRows(); // whisper installed, local-music pending
      const data = (await suggestProvider({ kind: "music" }, { surface: "cli" })).data as {
        suggested: string[];
        covered: Array<{ id: string; via: string }>;
      };
      // ACE-Step is not installed yet, so it is still worth offering.
      expect(data.suggested).toEqual(["elevenlabs", "ace-step"]);
      expect(data.covered).toEqual([]);
    });

    it("returns an honest empty result when libi's own extension already covers the kind", async () => {
      seedLibiRows(); // whisper is installed
      const res = await suggestProvider({ kind: "transcription" }, { surface: "in-app" });
      const data = res.data as { status: string; suggested: string[]; covered: unknown[]; note: string };
      // Whisper is the ONLY transcription provider in the catalog, and it is
      // already installed — there is nothing to suggest, so no card is offered.
      expect(data.status).toBe("none");
      expect(data.suggested).toEqual([]);
      expect(data.covered).toEqual([
        { id: "whisper", name: "Whisper (on-device transcription)", via: "extension" },
      ]);
      expect(data.note).toMatch(/nothing to suggest/i);
      // A provider connected after the chat started is covered here but has no tools in that chat.
      expect(data.note).toMatch(/it was added after this chat started: say so and tell the user to open a new chat to use it/);
      // Nothing to connect ⇒ no commands, no key placeholder.
      expect(JSON.stringify(data)).not.toContain("<your key>");
    });

    it("a provider connected after the chat started still gets 'open a new chat' when the rest of its kind is offered — in the app and from a CLI", async () => {
      // The default detection has fal connected and Higgsfield not, so video is only partly covered: the answer is a
      // card for Higgsfield, which is exactly what a user who just connected fal mid-chat gets on asking again.
      const inApp = (await suggestProvider({ kind: "video" }, { surface: "in-app", dialect: "claude" })).data as {
        status: string;
        covered: Array<{ id: string }>;
        note: string;
      };
      expect(inApp.status).toBe("card");
      expect(inApp.covered.map((c) => c.id)).toEqual(["fal"]);
      // Where the tools are listed: the config entry's name, not the catalog id.
      expect(inApp.note).toMatch(/its row in `connected` has the `name` its tools are listed under — search your deferred tools for that name first/);
      expect(inApp.note).toMatch(/it was added after this chat started: say so and tell the user to open a new chat to use it/);
      const cli = (await suggestProvider({ kind: "video" }, { surface: "cli", dialect: "claude" })).data as {
        status: string;
        covered: Array<{ id: string }>;
        note: string;
      };
      expect(cli.status).toBe("cli");
      expect(cli.covered.map((c) => c.id)).toEqual(["fal"]);
      // A CLI session is a session, and may sit in a project the entry is not registered for.
      expect(cli.note).toMatch(/added after this session started or is registered only for another project: tell the user to start a new session where it is registered/);
      expect(cli.note).not.toMatch(/open a new chat/);
    });

    it("counts only what is registered for the calling agent: fal added to Codex is not covered in a Claude chat", async () => {
      const codexOnly = [{ agent: "codex", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" }] as const;
      fetchProviders.mockResolvedValueOnce([...codexOnly]);
      const claude = (await suggestProvider({ kind: "video" }, { surface: "in-app", dialect: "claude" })).data as {
        status: string;
        connected: unknown[];
        covered: unknown[];
        suggested: Array<{ id: string }>;
      };
      expect(claude.status).toBe("card");
      expect(claude.connected).toEqual([]);
      expect(claude.covered).toEqual([]);
      expect(claude.suggested.map((s) => s.id)).toEqual(["fal", "higgsfield"]);

      fetchProviders.mockResolvedValueOnce([...codexOnly]);
      const codex = (await suggestProvider({ kind: "video" }, { surface: "in-app", dialect: "codex" })).data as {
        covered: Array<{ id: string }>;
        suggested: Array<{ id: string }>;
      };
      expect(codex.covered.map((c) => c.id)).toEqual(["fal"]);
      expect(codex.suggested.map((s) => s.id)).toEqual(["higgsfield"]);
    });

    it("a covered provider whose sign-in libi can't see is sent to sign in first, not only to a new chat", async () => {
      // The mock's type is inferred from its default rows, which carry no `signIn`.
      fetchProviders.mockResolvedValueOnce([
        { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown" } as never,
      ]);
      const data = (await suggestProvider({ kind: "video" }, { surface: "in-app", dialect: "claude" })).data as {
        connected: Array<{ name: string; signIn?: string }>;
        covered: Array<{ id: string }>;
        note: string;
      };
      expect(data.covered.map((c) => c.id)).toEqual(["higgsfield"]);
      expect(data.connected).toEqual([expect.objectContaining({ name: "higgsfield", signIn: "unknown" })]);
      expect(data.note).toMatch(/when that row's `signIn` is "unknown", to finish signing in to it on libi's Providers tab first/);
    });

    it("still suggests Whisper when the extension is not installed", async () => {
      const data = (await suggestProvider({ kind: "transcription" }, { surface: "cli" })).data as {
        status: string;
        suggested: string[];
      };
      expect(data.status).toBe("cli");
      expect(data.suggested).toEqual(["whisper"]);
    });
  });

  it("emits provider_suggested { kind } on both surfaces and nothing else", async () => {
    await suggestProvider({ kind: "sfx" }, { surface: "in-app" });
    await suggestProvider({ kind: "image", reason: "a poster" }, { surface: "cli" });
    expect(trackMcpEvent.mock.calls).toEqual([
      ["provider_suggested", { kind: "sfx" }],
      ["provider_suggested", { kind: "image" }],
    ]);
  });
});

describe("libi.list_providers", () => {
  it("returns the connected set and a value-free catalog projection", async () => {
    const res = await listProviders();
    const data = res.data as { connected: unknown[]; catalog: Array<Record<string, unknown>> };
    expect(data.connected).toHaveLength(1);
    expect(data.catalog).toHaveLength(6);
    for (const c of data.catalog) {
      expect(Object.keys(c).sort()).toEqual(["id", "kind", "kinds", "name"]);
    }
  });

  it("never leaks a command, a key name, or a match rule", async () => {
    const res = await listProviders();
    const s = JSON.stringify(res.data);
    expect(s).not.toContain("mcp add");
    expect(s).not.toContain("FAL_KEY");
  });

  // What `libi.list_mcp_servers` reported, folded in here so an agent
  // asking "who can make music" gets ACE-Step's install status beside
  // ACE-Step, instead of having to pick between two overlapping tools.
  it("reports libi's own rows and whether each is installed, in registry order", async () => {
    seedLibiRows();
    const data = (await listProviders()).data as {
      extensions: Array<{ id: string; name: string; installStatus: string; providerId: string | null }>;
    };
    expect(data.extensions.map((e) => e.id)).toEqual(["libi", "whisper", "local-music"]);
    expect(data.extensions.find((e) => e.id === "local-music")).toMatchObject({
      name: "Local Music (ACE-Step)",
      installStatus: "pending",
      // …and the catalog entry it answers for, so the agent can join the two.
      providerId: "ace-step",
    });
    expect(data.extensions.find((e) => e.id === "whisper")?.installStatus).toBe("installed");
    expect(data.extensions.find((e) => e.id === "libi")?.providerId).toBeNull();
  });

  it("re-derives install status from DISK before reporting it", async () => {
    // The QA reproduction: `libi.whisper_download_model` really downloaded the
    // model, nothing called `libi.update_dep_status`, and the row stayed
    // `pending` — so libi kept offering to install what was already there.
    seedLibiRows();
    settleInstallStatus.mockImplementation(async (id: string) => {
      if (id !== "local-music") return null;
      getDb()
        .update(mcpServers)
        .set({ installStatus: "installed" })
        .where(sql`${mcpServers.id} = 'local-music'`)
        .run();
      return "installed";
    });

    const data = (await listProviders()).data as {
      extensions: Array<{ id: string; installStatus: string }>;
    };
    expect(data.extensions.find((e) => e.id === "local-music")?.installStatus).toBe("installed");
    // Only the rows that ARE catalogue providers are probed; libi's core row
    // is not one and is never settled.
    expect(settleInstallStatus.mock.calls.map((c) => c[0])).not.toContain("libi");
  });

  it("never returns a row's env vars — the no-secrets guard list_mcp_servers carried", async () => {
    seedLibiRows();
    const s = JSON.stringify((await listProviders()).data);
    expect(s).not.toContain("hush");
    expect(s).not.toContain("SECRET");
  });

  it("answers with an empty extension list rather than throwing when the table is unreadable", async () => {
    // A degraded-DB failure mode that must not surface as a thrown error: an
    // older runtime opened this DB, or a migration is half applied.
    getDb().run(sql`DROP TABLE mcp_servers`);
    const res = await listProviders();
    expect(res.success).toBe(true);
    expect((res.data as { extensions: unknown[] }).extensions).toEqual([]);
  });

  it("still answers when detection fails", async () => {
    fetchProviders.mockRejectedValueOnce(new Error("server down"));
    const res = await listProviders();
    expect(res.success).toBe(true);
    expect((res.data as { connected: unknown[] }).connected).toEqual([]);
  });
});
