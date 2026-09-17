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
import { decidePermissionAction } from "@/lib/agents/session-event-handler";
import {
  isApprovalRequiredExtensionTool,
  isExtensionInstallTool,
} from "@/lib/approval/extensions";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

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
    expect(await decidePermissionAction("claude-code", req("mcp__libi-tracking__libi_compute_object_track")))
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
    expect(isApprovalRequiredExtensionTool(makeMcpToolId("libi-tracking", "libi.compute_object_track"))).toBe(true);
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
    expect(isExtensionInstallTool("libi.compute_object_track")).toBe(false);
  });
});
