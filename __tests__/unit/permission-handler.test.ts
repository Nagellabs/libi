import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(),
}));
vi.mock("@/lib/approval/generation", () => ({
  isGenerationTool: vi.fn(),
}));
// Stub out the DB-dependent modules so tests don't need a real database.
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

import { getApprovalMode } from "@/lib/approval/settings";
import { isGenerationTool } from "@/lib/approval/generation";
import { decidePermissionAction } from "@/lib/agents/session-event-handler";

/**
 * Build a `RequestPermissionRequest` shaped the way claude-agent-acp
 * produces them. For MCP tools, the SDK's `toolInfoFromToolUse` falls
 * through to the default branch and sets `title` to the canonical
 * `mcp__server__tool` name — which is what we feed `isGenerationTool`.
 */
const acpRequest = (
  toolName: string,
  optionKinds: Array<"allow_once" | "allow_always" | "reject_once" | "reject_always">,
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

describe("decidePermissionAction", () => {
  beforeEach(() => vi.resetAllMocks());

  it("ask mode + acp tool → prompt", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("ask");
    vi.mocked(isGenerationTool).mockReturnValue(false);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("Edit", ["allow_once", "reject_once"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("auto mode + non-generation tool with allow option → auto-allow", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    vi.mocked(isGenerationTool).mockReturnValue(false);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("Edit", ["allow_once", "reject_once"]),
    );
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("auto mode + non-generation tool with NO allow option → prompt (classifier-flagged case)", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    vi.mocked(isGenerationTool).mockReturnValue(false);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("Edit", ["reject_once", "reject_always"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("auto mode + generation tool → prompt with reason 'generation'", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    vi.mocked(isGenerationTool).mockReturnValue(true);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("mcp__elevenlabs__tts", ["allow_once", "reject_once"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "generation" });
  });

  it("auto-with-generations + generation tool with allow option → auto-allow", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto-with-generations");
    vi.mocked(isGenerationTool).mockReturnValue(true);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("mcp__elevenlabs__tts", ["allow_once"]),
    );
    expect(action).toEqual({ kind: "auto-allow", optionId: "opt-0-allow_once" });
  });

  it("auto-with-generations + classifier-flagged → prompt (no allow option to choose)", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto-with-generations");
    vi.mocked(isGenerationTool).mockReturnValue(false);
    const action = await decidePermissionAction(
      "claude-code",
      acpRequest("download", ["reject_once"]),
    );
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });

  it("uses rawInput.name when title is missing", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    // Canonical-id branch: fromAnyToolName normalizes
    // "mcp__elevenlabs__tts" → "elevenlabs:tts" via the bundled MCP list.
    vi.mocked(isGenerationTool).mockImplementation(
      (id) => id === "elevenlabs:tts",
    );
    const action = await decidePermissionAction("claude-code", {
      sessionId: "s1",
      toolCall: {
        toolCallId: "t1",
        rawInput: { name: "mcp__elevenlabs__tts" },
      } as unknown as RequestPermissionRequest["toolCall"],
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
    } as RequestPermissionRequest);
    expect(action).toEqual({ kind: "prompt", reason: "generation" });
  });

  it("returns prompt(acp) when neither title nor rawInput.name resolve a generation tool", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    vi.mocked(isGenerationTool).mockReturnValue(false);
    const action = await decidePermissionAction("claude-code", {
      sessionId: "s1",
      toolCall: {
        toolCallId: "t1",
      } as unknown as RequestPermissionRequest["toolCall"],
      options: [],
    } as RequestPermissionRequest);
    expect(action).toEqual({ kind: "prompt", reason: "acp" });
  });
});

