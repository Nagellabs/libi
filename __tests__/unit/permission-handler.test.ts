import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(),
}));

import { getApprovalMode } from "@/lib/approval/settings";
import { decidePermissionAction, extractToolMeta, nameToolCall, SessionEventHandler, withholdAllowAlways } from "@/lib/agents/session-event-handler";
import { formatToolId } from "@/lib/agents/format-tool-name";
import {
  isApprovalRequiredExtensionTool,
  isExtensionInstallTool,
} from "@/lib/approval/extensions";
import { fromAnyToolName, makeMcpToolId } from "@/lib/agents/mcp-tool-id";

/**
 * Build a `RequestPermissionRequest` shaped the way claude-agent-acp
 * produces them. For MCP tools, the SDK's `toolInfoFromToolUse` falls
 * through to the default branch and sets `title` to the canonical
 * `mcp__server__tool` name.
 */
const req = (
  toolName: string,
  optionKinds: Array<"allow_once" | "allow_always" | "reject_once" | "reject_always"> = [
    "allow_once",
    "reject_once",
  ],
): RequestPermissionRequest => ({
  sessionId: "s1",
  toolCall: {
    toolCallId: "t1",
    title: toolName,
    rawInput: { name: toolName },
  },
  options: optionKinds.map((kind, i) => ({
    optionId: `opt-${i}-${kind}`,
    name: kind,
    kind,
  })),
});

// The mocked getApprovalMode stands in for the brief's `setApprovalMode` —
// the real setter writes the settings row, which this pure decision test
// does not need.
function setApprovalMode(_agentId: string, mode: "ask" | "auto" | "auto-with-generations") {
  vi.mocked(getApprovalMode).mockReturnValue(mode);
}

/** Seed one `mcp_servers` row the way `seedDatabase` would, with the
 *  approval flag under test. `createTestDb` builds the schema only. */
function seedExtensionRow(id: string, requireApproval: boolean) {
  getDb()
    .insert(mcpServers)
    .values({ id, name: id, type: "stdio", bundled: true, requireApproval })
    .run();
}

// Every describe below runs against the in-memory DB so no code path — even
// one that turns out to read `mcp_servers` unexpectedly — can reach a real
// `~/.libi` database from a unit test.
beforeEach(() => {
  vi.resetAllMocks();
  createTestDb();
});
afterEach(() => resetTestDb());

describe("decidePermissionAction", () => {
  it("ask mode + built-in tool → prompt", async () => {
    setApprovalMode("claude-code", "ask");
    const action = await decidePermissionAction("claude-code", req("Edit"));
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("auto mode + built-in tool with allow option → auto-allow", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction("claude-code", req("Edit"));
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("auto mode + tool with NO allow option → prompt (classifier-flagged case)", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction(
      "claude-code",
      req("Edit", ["reject_once", "reject_always"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("auto mode auto-allows an ordinary tool", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction(
      "claude-code",
      req("mcp__libi-app__libi_list_pieces"),
    );
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("ask mode prompts with reason acp for an ordinary tool", async () => {
    setApprovalMode("claude-code", "ask");
    const action = await decidePermissionAction(
      "claude-code",
      req("mcp__libi-app__libi_list_pieces"),
    );
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("auto-with-generations auto-allows an ordinary tool", async () => {
    setApprovalMode("claude-code", "auto-with-generations");
    const action = await decidePermissionAction(
      "claude-code",
      req("mcp__libi-app__libi_list_pieces", ["allow_once"]),
    );
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("auto-with-generations + classifier-flagged → prompt (no allow option to choose)", async () => {
    setApprovalMode("claude-code", "auto-with-generations");
    const action = await decidePermissionAction("claude-code", req("download", ["reject_once"]));
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("returns prompt(acp) when the request carries neither title nor rawInput.name and no options", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction("claude-code", {
      sessionId: "s1",
      toolCall: {
        toolCallId: "t1",
      } as unknown as RequestPermissionRequest["toolCall"],
      options: [],
    } as RequestPermissionRequest);
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  // This used to assert `fs.existsSync("lib/approval/generation.ts")`
  // is false — which proves a FILE is absent, not that the gate it fed is
  // gone. A behaviourally identical gate reinstated anywhere else (inline in
  // decidePermissionAction, in extensions.ts, off a registry flag) would have
  // passed that check untouched. What the removal actually means is below: in
  // `auto`, a paid generation tool is decided by the extension row and
  // nothing else, so a provider MCP's generation tool runs without a prompt.
  it("no longer holds a paid generation tool back in auto mode", async () => {
    setApprovalMode("claude-code", "auto");
    for (const wire of [
      // Provider MCPs the USER connected — libi owns no row for these at all,
      // so there is nothing left that could gate them.
      "mcp__fal-ai__fal_generate_image",
      "mcp__fal-ai__fal_text_to_video",
      "mcp__elevenlabs__text_to_speech",
    ]) {
      expect(await decidePermissionAction("claude-code", req(wire)), wire)
        .toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
    }
  });

  it("keeps `auto-with-generations` a synonym for auto on a non-extension tool", async () => {
    // The middle mode survived the removal by name only — what it holds back
    // is the extension gate now, never a "generation" classification. So on a
    // tool no extension owns it must be indistinguishable from `auto`.
    for (const mode of ["auto", "auto-with-generations"] as const) {
      setApprovalMode("claude-code", mode);
      expect(await decidePermissionAction("claude-code", req("mcp__fal-ai__fal_generate_image")), mode)
        .toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
    }
  });
});

// ---------------------------------------------------------------------------
// The extension approval gate. `requireApproval` on an extension's
// `mcp_servers` row is enforced in-app: `auto` prompts for that extension's
// tools, `ask` always prompts (with the extension reason), and
// `auto-with-generations` never prompts.
// ---------------------------------------------------------------------------

describe("extension approval gate", () => {
  beforeEach(() => {
    seedExtensionRow("local-music", true);
    seedExtensionRow("whisper", false);
    seedExtensionRow("libi-tracking", true);
    seedExtensionRow("libi-export", true);
    seedExtensionRow("youtube-download", true);
  });

  it("gates libi.export_video by the libi-export row", async () => {
    setApprovalMode("claude-code", "auto");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_export_video")))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  it("gates libi.download_video by the youtube-download row", async () => {
    setApprovalMode("claude-code", "auto");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_download_video")))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  it("prompts in auto mode for a tool owned by an approval-required extension", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction("claude-code", req("mcp__libi-app__libi_generate_music"));
    expect(action).toEqual({ kind: "prompt", reason: "extension" });
  });

  it("prompts in auto mode even when the agent offers an allow option", async () => {
    // The gate must win over the agent's allow option — that option is what
    // `auto` would otherwise select silently.
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction(
      "claude-code",
      req("mcp__libi-app__libi_music_list_styles", ["allow_always", "allow_once", "reject_once"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "extension" });
  });

  it("does not prompt in auto mode when the extension's row is off", async () => {
    setApprovalMode("claude-code", "auto");
    const action = await decidePermissionAction("claude-code", req("mcp__libi-app__libi_whisper_list_models"));
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("never prompts in auto-with-generations, even for an approval-required extension", async () => {
    setApprovalMode("claude-code", "auto-with-generations");
    const action = await decidePermissionAction("claude-code", req("mcp__libi-app__libi_generate_music"));
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("always prompts in ask mode, with reason extension for an extension tool", async () => {
    setApprovalMode("claude-code", "ask");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_generate_music")))
      .toEqual({ kind: "prompt", reason: "extension" });
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_list_pieces")))
      .toEqual({ kind: "prompt", reason: "acp" });
  });

  it("ask mode keeps reason acp for a tool of an extension whose row is off", async () => {
    setApprovalMode("claude-code", "ask");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_whisper_list_models")))
      .toEqual({ kind: "prompt", reason: "acp" });
  });

  /**
   * The title shape codex-acp 1.10.0 ACTUALLY emits (`mcp.<entry>.<tool>`,
   * spike S2), plus the older adapter's `<entry>/<tool>`. This case used to
   * assert `Tool: libi-app/libi-app.libi.generate_music` — a doubled-entry
   * title no codex build has emitted — so it proved the gate matched a string
   * that never arrives while every real codex call canonicalized to null.
   *
   * NOTE the gate itself is still Claude-only in practice: an ACP permission
   * request from codex carries no title and no rawInput at all (see
   * lib/sessions/approval-mode-map.ts). What this asserts is that IF a name
   * reaches `extractToolMeta`, every codex spelling of it resolves to the same
   * extension the claude wire name does.
   */
  it("matches the codex title forms too", async () => {
    setApprovalMode("claude-code", "auto");
    expect(await decidePermissionAction("claude-code", req("mcp.libi-app.libi.generate_music")))
      .toEqual({ kind: "prompt", reason: "extension" });
    expect(await decidePermissionAction("claude-code", req("Tool: libi-app/libi.generate_music")))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  /**
   * …and the structured envelope, which is what codex-acp puts on the
   * `tool_call` update beside that title. `extractToolMeta` prefers it, so a
   * future codex build that attaches it to the permission request too is
   * gated without another change here.
   */
  it("matches codex's structured MCP payload on the request", async () => {
    setApprovalMode("claude-code", "auto");
    const structured = {
      ...req("mcp.libi-app.libi.generate_music"),
      toolCall: {
        toolCallId: "t1",
        rawInput: { server: "libi-app", tool: "libi.generate_music", arguments: {} },
      },
    } as Parameters<typeof decidePermissionAction>[1];
    expect(await decidePermissionAction("claude-code", structured))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  it("does not gate a built-in tool", async () => {
    setApprovalMode("claude-code", "auto");
    expect(await decidePermissionAction("claude-code", req("Read")))
      .toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  // Controller note N1: an extension's install/download tools are how the
  // user gets past "not installed" — they must never be held behind the
  // extension's own approval flag.
  it("exempts an extension's install and download tools from the gate", async () => {
    setApprovalMode("claude-code", "auto");
    for (const wire of [
      "mcp__libi-app__libi_music_download_model",
      "mcp__libi-app__libi_music_install_analysis_deps",
      "mcp__libi-app__libi_install_tracking_engine",
    ]) {
      expect(await decidePermissionAction("claude-code", req(wire)), wire)
        .toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
    }
    // …while a sibling tool under the same prefix is still gated.
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_music_list_styles")))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  // `libi.verify_install` is the read-only "is the tracking engine
  // installed?" check on the same path — holding it behind the flag would
  // gate the question, not the install.
  it("exempts libi.verify_install (the read-only install check) from the gate", async () => {
    setApprovalMode("claude-code", "auto");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-tracking__libi_verify_install")))
      .toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
    // …while a real tracking tool on the same server is still gated.
    expect(await decidePermissionAction("claude-code", req("mcp__libi-tracking__libi_track")))
      .toEqual({ kind: "prompt", reason: "extension" });
  });

  it("an exempt install tool prompts with the generic reason in ask mode", async () => {
    setApprovalMode("claude-code", "ask");
    expect(await decidePermissionAction("claude-code", req("mcp__libi-app__libi_music_download_model")))
      .toEqual({ kind: "prompt", reason: "acp" });
  });
});

describe("isApprovalRequiredExtensionTool", () => {
  it("is false for a built-in tool (null id)", () => {
    expect(isApprovalRequiredExtensionTool(null)).toBe(false);
  });

  it("is false for a provider MCP's tool, even one whose name looks like an extension's", () => {
    // Only libi's own server ids reach the DB read — a provider MCP's approval
    // behaviour is the agent's business.
    seedExtensionRow("local-music", true);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("fal-ai", "libi.generate_music"))).toBe(false);
  });

  it("is false for a core libi tool that no extension prefix owns", () => {
    seedExtensionRow("local-music", true);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.list_pieces"))).toBe(false);
  });

  it("reads the row: true when the owning extension requires approval, false when it does not", () => {
    seedExtensionRow("local-music", true);
    seedExtensionRow("whisper", false);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.generate_music"))).toBe(true);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.whisper_list_models"))).toBe(false);
  });

  it("falls back to the def's own default when the row is missing", () => {
    // A DB that predates the def has no row; every shipped extension defaults
    // to requireApproval: false.
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.generate_music"))).toBe(false);
  });

  it("gates a tracking-server tool by the libi-tracking row", () => {
    seedExtensionRow("libi-tracking", true);
    // Both merged tracking tools (every action of them) sit under the extension, on either server.
    for (const server of ["libi-tracking", "libi"]) {
      expect(isApprovalRequiredExtensionTool(makeMcpToolId(server, "libi.track")), `${server} libi.track`).toBe(true);
      expect(isApprovalRequiredExtensionTool(makeMcpToolId(server, "libi.tracked_overlay")), `${server} libi.tracked_overlay`).toBe(true);
    }
    // …and the cutout tool, which stays a separate tool of the same extension.
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi-tracking", "libi.remove_background"))).toBe(true);
    // The prefixes claim no more than they did: overlay tools without a tracking name are untouched.
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.add_overlay"))).toBe(false);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.analysis_save"))).toBe(false);
  });

  it("never returns true for an install tool, whatever the row says", () => {
    seedExtensionRow("local-music", true);
    seedExtensionRow("libi-tracking", true);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi", "libi.music_download_model"))).toBe(false);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi-tracking", "libi.install_tracking_engine"))).toBe(false);
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi-tracking", "libi.verify_install"))).toBe(false);
  });
});

describe("isExtensionInstallTool", () => {
  it("names exactly the install-path tools of the shipped extensions", () => {
    for (const name of [
      "libi.install_tracking_engine",
      "libi.verify_install",
      "libi.whisper_download_model",
      "libi.tts_download_model",
      "libi.music_download_model",
      "libi.music_install_analysis_deps",
    ]) {
      expect(isExtensionInstallTool(name), name).toBe(true);
    }
    expect(isExtensionInstallTool("libi.generate_music")).toBe(false);
    expect(isExtensionInstallTool("libi.music_list_styles")).toBe(false);
    expect(isExtensionInstallTool("libi.track")).toBe(false);
    expect(isExtensionInstallTool("libi.tracked_overlay")).toBe(false);
  });
});

/**
 * 2026-09-24 — "an agent can prepare a publish; only you can publish."
 * `libi.publish_template` only records a publish request (the user publishes
 * it on the Templates page), so the approval card is no longer the guard and
 * the tool is an ordinary call: no special reason, no trimmed options, no
 * special answer for an unknown session. The guard is structural — see the
 * LIMITATIONS in lib/approval/extensions.ts.
 */
describe("publish_template is an ordinary tool call — the Templates page is the guard", () => {
  const ALL = ["reject_once", "allow_once", "allow_always"] as const;
  const WIRES = ["mcp__libi__libi_publish_template", "mcp__libi-app__libi_publish_template", "mcp.libi.libi.publish_template"];

  it("auto modes allow it like any libi tool; ask mode asks like any tool", async () => {
    for (const mode of ["auto", "auto-with-generations"] as const) {
      setApprovalMode("claude-code", mode);
      for (const wire of WIRES) expect(await decidePermissionAction("claude-code", req(wire, [...ALL])), `${mode}: ${wire}`).toEqual({ kind: "auto-allow", optionId: "opt-1-allow_once" });
    }
    setApprovalMode("claude-code", "ask");
    for (const wire of WIRES) expect(await decidePermissionAction("claude-code", req(wire, [...ALL])), wire).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("a prompt for it offers every option the agent sent, Always Allow included", async () => {
    setApprovalMode("claude-code", "ask");
    const emit = vi.fn();
    const session = { agentId: "claude-code", pendingApprovals: new Map() };
    const handler = new SessionEventHandler(
      { next: () => 1 },
      emit,
      (() => session) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );
    void handler.handlePermissionRequest(req("mcp__libi__libi_publish_template", [...ALL]));
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const event = emit.mock.calls[0][1] as { type: string; reason: string; options: Array<{ kind: string }> };
    expect(event).toMatchObject({ type: "agent-permission-request", reason: "acp" });
    expect(event.options.map((o) => o.kind)).toEqual([...ALL]);
  });
});

// A request libi cannot route (its session is not in the map — a race with a
// session teardown, or a standby never claimed) is answered with the first
// allow option so the agent does not hang.
describe("a permission request for a session libi cannot look up", () => {
  const handlerWithNoSessions = () =>
    new SessionEventHandler(
      { next: () => 1 },
      vi.fn(),
      (() => undefined) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );

  it("answers publish_template like any tool: preparing a publish publishes nothing", async () => {
    const r = await handlerWithNoSessions().handlePermissionRequest(req("mcp__libi__libi_publish_template", ["reject_once", "allow_once"]));
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "opt-1-allow_once" } });
  });

  it("still picks the first allow option for an ordinary tool", async () => {
    const r = await handlerWithNoSessions().handlePermissionRequest(req("mcp__libi__libi_apply_template", ["reject_once", "allow_once"]));
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "opt-1-allow_once" } });
  });
});

/**
 * A merged libi tool is remembered per tool NAME by the agent ("don't ask again" /
 * "Allow for this session"), so one "always" on a harmless action would cover its destructive
 * siblings. `MERGED_TOOL_RISK` declares which merged tools may keep the option.
 */
describe("a merged libi tool is never offered 'don't ask again' when it has a changing action", () => {
  const ALL = ["allow_always", "allow_once", "reject_once"] as const;
  const kindsOf = (r: RequestPermissionRequest) => r.options.map((o) => o.kind);

  const prompted = async (request: RequestPermissionRequest, session: Record<string, unknown> = {}) => {
    setApprovalMode("claude-code", "ask");
    const emit = vi.fn();
    const entry = { agentId: "claude-code", pendingApprovals: new Map(), messageCache: [], ...session };
    const handler = new SessionEventHandler(
      { next: () => 1 },
      emit,
      (() => entry) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );
    void handler.handlePermissionRequest(request);
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const event = emit.mock.calls[0][1] as { options: Array<{ kind: string }> };
    return { kinds: event.options.map((o) => o.kind), entry };
  };

  it("withholdAllowAlways drops allow_always for a mixed merged tool, on either libi server", () => {
    for (const wire of ["mcp__libi__libi_snapshot", "mcp__libi-app__libi_snapshot", "mcp__libi-tracking__libi_track", "mcp__libi__libi_tracked_overlay"]) {
      const r = req(wire, [...ALL]);
      const toolId = extractToolMeta(r).toolId;
      expect(kindsOf(withholdAllowAlways(r, toolId)), wire).toEqual(["allow_once", "reject_once"]);
    }
  });

  it("keeps it for a merged tool whose every action only reads, and for every non-merged tool", () => {
    for (const wire of ["mcp__libi__libi_analysis_query", "mcp__libi__libi_show", "mcp__libi__libi_delete_piece", "mcp__fal-ai__run_model", "Edit"]) {
      const r = req(wire, [...ALL]);
      expect(withholdAllowAlways(r, extractToolMeta(r).toolId), wire).toBe(r);
    }
  });

  it("does not touch a same-named tool of another server", () => {
    const r = req("mcp__other__libi_snapshot", [...ALL]);
    expect(withholdAllowAlways(r, extractToolMeta(r).toolId)).toBe(r);
  });

  it("the card for a mixed tool carries no remember option; the read-only and ordinary ones keep theirs", async () => {
    expect((await prompted(req("mcp__libi__libi_snapshot", [...ALL]))).kinds).toEqual(["allow_once", "reject_once"]);
    expect((await prompted(req("mcp__libi__libi_analysis_query", [...ALL]))).kinds).toEqual([...ALL]);
    expect((await prompted(req("mcp__libi__libi_list_pieces", [...ALL]))).kinds).toEqual([...ALL]);
  });

  it("an option the card never showed cannot be answered: the stored options are the trimmed ones", async () => {
    const { entry } = await prompted(req("mcp__libi__libi_snapshot", [...ALL]));
    const [pending] = [...(entry.pendingApprovals as Map<string, { options: Array<{ kind: string }> }>).values()];
    expect(pending.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  it("an auto mode never picks the withheld option (the extension gate's tracking tool included)", async () => {
    setApprovalMode("claude-code", "auto");
    const handler = new SessionEventHandler(
      { next: () => 1 },
      vi.fn(),
      (() => ({ agentId: "claude-code", pendingApprovals: new Map(), messageCache: [] })) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );
    // allow_always listed FIRST, as claude-agent-acp lists its remember option
    const r = await handler.handlePermissionRequest(req("mcp__libi__libi_snapshot", ["allow_always", "allow_once", "reject_once"]));
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "opt-1-allow_once" } });
  });

  it("an extension-gated tracking call in auto mode asks without a remember option", async () => {
    seedExtensionRow("libi-tracking", true);
    setApprovalMode("claude-code", "auto");
    const emit = vi.fn();
    const handler = new SessionEventHandler(
      { next: () => 1 },
      emit,
      (() => ({ agentId: "claude-code", pendingApprovals: new Map(), messageCache: [] })) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );
    void handler.handlePermissionRequest(req("mcp__libi-tracking__libi_track", [...ALL]));
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const event = emit.mock.calls[0][1] as { reason: string; options: Array<{ kind: string }> };
    expect(event.reason).toBe("extension");
    expect(event.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  it("a Codex approval is nameless: the tool comes from the tool_call cached under the same toolCallId", async () => {
    const nameless: RequestPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "codex-call-1", kind: "execute", status: "pending" } as RequestPermissionRequest["toolCall"],
      options: ALL.map((kind, i) => ({ optionId: `o${i}`, name: kind, kind })),
    };
    const cached = (toolId: string) => ({
      messageCache: [{ role: "agent", parts: [{ type: "tool-call", toolCallId: "codex-call-1", toolId, rawTitle: "", args: {} }] }],
    });
    expect((await prompted(nameless, cached("libi:libi.snapshot"))).kinds).toEqual(["allow_once", "reject_once"]);
    expect((await prompted(nameless, cached("libi:libi.list_pieces"))).kinds).toEqual([...ALL]);
    // nothing cached: unchanged (the card cannot say what it is either)
    expect((await prompted(nameless)).kinds).toEqual([...ALL]);
  });

  /**
   * Fix-wave re-run 2026-10-02: the Codex card for `libi.snapshot` discard read only "Permission required",
   * because the request is nameless. The same recovery that withholds allow-always now names the card.
   */
  describe("a Codex approval's card is named from the cached tool_call", () => {
    const ONCE = ["allow_once", "reject_once"] as const;
    const nameless = (id = "exec-1"): RequestPermissionRequest => ({
      sessionId: "s1",
      toolCall: { toolCallId: id, kind: "execute", status: "pending" } as RequestPermissionRequest["toolCall"],
      options: ONCE.map((kind, i) => ({ optionId: `o${i}`, name: kind, kind })),
    });
    const withCall = (part: Record<string, unknown>) => ({
      messageCache: [{ role: "agent", parts: [{ type: "tool-call", toolCallId: "exec-1", ...part }] }],
    });
    const shown = async (request: RequestPermissionRequest, session: Record<string, unknown> = {}) => {
      setApprovalMode("codex", "ask");
      const emit = vi.fn();
      const entry = { agentId: "codex", pendingApprovals: new Map(), messageCache: [] as unknown[], ...session };
      const handler = new SessionEventHandler(
        { next: () => 1 },
        emit,
        (() => entry) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
      );
      void handler.handlePermissionRequest(request);
      await vi.waitFor(() => expect(emit).toHaveBeenCalled());
      const event = emit.mock.calls[0][1] as { toolCall: { title?: string; rawInput?: unknown } };
      const [pending] = [...(entry.pendingApprovals as Map<string, { toolCall: { title?: string } }>).values()];
      return { event, pending };
    };
    const SNAPSHOT_ARGS = { server: "libi", tool: "libi.snapshot", arguments: { action: "discard", pieceId: "p", confirm: true } };

    it("carries the cached title and arguments on the event, so every renderer can name the action", async () => {
      const { event, pending } = await shown(
        nameless(),
        withCall({ toolId: "libi:libi.snapshot", rawTitle: "mcp.libi.libi.snapshot", args: SNAPSHOT_ARGS }),
      );
      expect(event.toolCall).toMatchObject({ toolCallId: "exec-1", title: "mcp.libi.libi.snapshot", rawInput: SNAPSHOT_ARGS });
      // the stored copy (what a reload serves) is named too
      expect(pending.toolCall.title).toBe("mcp.libi.libi.snapshot");
      // and the title formats like the Claude card's: "Libi Snapshot · discard"
      expect(fromAnyToolName(event.toolCall.title!)).toBe("libi:libi.snapshot");
      expect(formatToolId(fromAnyToolName(event.toolCall.title!)!, event.toolCall.rawInput)).toBe("Libi Snapshot · discard");
    });

    it("falls back to the canonical tool id when the cached part has no title", async () => {
      const { event } = await shown(nameless(), withCall({ toolId: "libi:libi.list_pieces", rawTitle: "", args: {} }));
      expect(event.toolCall.title).toBe("libi:libi.list_pieces");
      expect(formatToolId(fromAnyToolName(event.toolCall.title!)!, event.toolCall.rawInput)).toBe("Libi List pieces");
    });

    it("names a built-in call by its cached title", async () => {
      const { event } = await shown(nameless(), withCall({ toolId: null, rawTitle: "Read file '/tmp/a.md'" }));
      expect(event.toolCall.title).toBe("Read file '/tmp/a.md'");
    });

    it("leaves the request untouched when nothing is cached under its toolCallId, or the call is for another id", async () => {
      expect((await shown(nameless())).event.toolCall.title).toBeUndefined();
      const other = withCall({ toolId: "libi:libi.snapshot", rawTitle: "mcp.libi.libi.snapshot", args: SNAPSHOT_ARGS });
      expect((await shown(nameless("exec-2"), other)).event.toolCall.title).toBeUndefined();
    });

    it("never overwrites a title the agent sent (Claude's request)", async () => {
      const claude = req("mcp__libi__libi_snapshot", [...ONCE]);
      const { event } = await shown(claude, withCall({ toolId: "libi:libi.list_pieces", rawTitle: "mcp.libi.libi.list_pieces", args: {} }));
      expect(event.toolCall.title).toBe("mcp__libi__libi_snapshot");
    });

    it("naming the card changes no decision: an auto mode still runs it as the agent sent it", async () => {
      setApprovalMode("codex", "auto");
      const handler = new SessionEventHandler(
        { next: () => 1 },
        vi.fn(),
        (() => ({ agentId: "codex", pendingApprovals: new Map(), ...withCall({ toolId: "libi:libi.list_pieces", rawTitle: "mcp.libi.libi.list_pieces", args: {} }) })) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
      );
      expect(await handler.handlePermissionRequest(nameless())).toEqual({ outcome: { outcome: "selected", optionId: "o0" } });
    });

    it("nameToolCall: untouched without a title to give, keeps an existing rawInput", () => {
      const tc = nameless().toolCall;
      expect(nameToolCall(tc, { toolId: null, rawTitle: "" })).toBe(tc);
      expect(nameToolCall({ ...tc, rawInput: { keep: 1 } } as typeof tc, { toolId: null, rawTitle: "Bash", args: { x: 1 } })).toMatchObject({ title: "Bash", rawInput: { keep: 1 } });
    });
  });

  it("the unknown-session fallback never selects a withheld option", async () => {
    const handler = new SessionEventHandler(
      { next: () => 1 },
      vi.fn(),
      (() => undefined) as unknown as ConstructorParameters<typeof SessionEventHandler>[2],
    );
    const r = await handler.handlePermissionRequest(req("mcp__libi__libi_snapshot", ["allow_always", "allow_once"]));
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "opt-1-allow_once" } });
  });
});
