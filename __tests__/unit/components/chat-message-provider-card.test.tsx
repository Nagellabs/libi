// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ChatMessage from "@/components/chat/chat-message";
import type { AgentMessage } from "@/hooks/sessions/use-agent-chat";
import { formatToolId } from "@/lib/agents/format-tool-name";
import { fromAnyToolName, parseMcpToolId, toolIdForCall, type McpToolId } from "@/lib/agents/mcp-tool-id";

/**
 * `libi.suggest_provider` as the chat reducer stores it: a tool-call part and,
 * later, a tool-result part whose MCP content text is the JSON tool output.
 * The chip is never shown; the card replaces it once a "card" result is in.
 */
const TOOL_ID = "libi:libi.suggest_provider";
const CLAUDE_TITLE = "mcp__libi__libi_suggest_provider";

const cardOutput = {
  success: true,
  data: {
    status: "card",
    kind: "video",
    connected: [],
    covered: [],
    suggested: [
      { id: "fal", name: "fal.ai", kinds: ["image", "video"], kind: "remote-mcp" },
      { id: "higgsfield", name: "Higgsfield", kinds: ["image", "video"], kind: "remote-mcp" },
    ],
    note: "A card with one button per suggestion is now in the chat.",
  },
};

function mcpContent(output: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(output) }] };
}

function message(opts: {
  rawTitle?: string;
  toolId?: string | null;
  result?: { result: unknown; success: boolean };
}): AgentMessage {
  const toolId = (opts.toolId === undefined ? TOOL_ID : opts.toolId) as McpToolId | null;
  const rawTitle = opts.rawTitle ?? CLAUDE_TITLE;
  return {
    id: "agent_suggest_1",
    role: "agent",
    timestamp: Date.now(),
    isStreaming: false,
    parts: [
      { type: "text", text: "Let me check what can make video." },
      { type: "tool-call", toolCallId: "tc1", toolId, rawTitle, args: { kind: "video" } },
      ...(opts.result
        ? [{ type: "tool-result" as const, toolCallId: "tc1", toolId, rawTitle, ...opts.result }]
        : []),
    ],
  };
}

const card = () => screen.queryByTestId("provider-suggestion-card");
/** The chip label ToolCallGroup would print for this call. */
const chipLabel = formatToolId(TOOL_ID as McpToolId);

function expectNoChip() {
  expect(screen.queryByText(chipLabel)).not.toBeInTheDocument();
  expect(screen.queryByText(/suggest_provider/i)).not.toBeInTheDocument();
}

describe("ChatMessage — libi.suggest_provider card", () => {
  it("the chip assertion can see a chip (control: an ordinary libi tool call renders one)", () => {
    const listId = "libi:libi.list_pieces" as McpToolId;
    render(
      <ChatMessage
        message={{
          id: "agent_control",
          role: "agent",
          timestamp: Date.now(),
          isStreaming: false,
          parts: [{ type: "tool-call", toolCallId: "tc0", toolId: listId, rawTitle: "mcp__libi__libi_list_pieces", args: {} }],
        }}
        animate={false}
        sessionId="sess-1"
      />,
    );
    expect(screen.getByText(formatToolId(listId))).toBeInTheDocument();
  });

  it("renders nothing for the call before its result arrives", () => {
    render(<ChatMessage message={message({})} animate={false} sessionId="sess-1" />);
    expect(screen.getByText("Let me check what can make video.")).toBeInTheDocument();
    expectNoChip();
    expect(card()).toBeNull();
  });

  it("renders the card in place of the chip once the card result is in, linking back to this session", () => {
    render(
      <ChatMessage
        message={message({ result: { result: mcpContent(cardOutput), success: true } })}
        animate={false}
        sessionId="sess-1"
      />,
    );
    expect(card()).toBeInTheDocument();
    expect(screen.getByText("To make video you need a provider")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connect fal\.ai/ })).toHaveAttribute(
      "href",
      "/agents?tab=providers&provider=fal&from=sess-1",
    );
    expect(screen.getByRole("link", { name: /Connect Higgsfield/ })).toBeInTheDocument();
    expectNoChip();
  });

  it("detects a codex call by its canonical id, not its presentation title", () => {
    render(
      <ChatMessage
        message={message({ rawTitle: "mcp.libi.libi.suggest_provider", result: { result: mcpContent(cardOutput), success: true } })}
        animate={false}
        sessionId="sess-1"
      />,
    );
    expect(card()).toBeInTheDocument();
    expect(screen.queryByText(/mcp\.libi\.libi\.suggest_provider/)).not.toBeInTheDocument();
  });

  it("detects the call by toolId when the title is a human string (no title fallback possible)", () => {
    // The shape `toolIdForCall` yields for a codex call whose structured
    // rawInput names the server and tool while the title is prose.
    const humanTitle = "Suggest a provider";
    const toolId = toolIdForCall(humanTitle, { server: "libi", tool: "libi.suggest_provider", arguments: { kind: "video" } });
    expect(toolId).toBe(TOOL_ID);
    // The title on its own canonicalizes to nothing libi-shaped, so only the id can match.
    expect(parseMcpToolId(fromAnyToolName(humanTitle) ?? "")?.toolName).not.toBe("libi.suggest_provider");
    render(
      <ChatMessage
        message={message({ rawTitle: humanTitle, toolId, result: { result: mcpContent(cardOutput), success: true } })}
        animate={false}
        sessionId="sess-1"
      />,
    );
    expect(card()).toBeInTheDocument();
    expect(screen.getByText("To make video you need a provider")).toBeInTheDocument();
    expect(screen.queryByText(humanTitle)).not.toBeInTheDocument();
  });

  it("renders neither chip nor card for a none result", () => {
    const none = { success: true, data: { ...cardOutput.data, status: "none", suggested: [] } };
    render(
      <ChatMessage message={message({ result: { result: mcpContent(none), success: true } })} animate={false} sessionId="sess-1" />,
    );
    expectNoChip();
    expect(card()).toBeNull();
  });

  it("renders neither chip nor card for an errored result (success: false)", () => {
    render(
      <ChatMessage
        message={message({ result: { result: mcpContent(cardOutput), success: false } })}
        animate={false}
        sessionId="sess-1"
      />,
    );
    expectNoChip();
    expect(card()).toBeNull();
  });

  it("renders neither chip nor card for an errored result (isError: true)", () => {
    const errored = { ...mcpContent({ success: false, error: "detection exploded" }), isError: true };
    render(
      <ChatMessage message={message({ result: { result: errored, success: false } })} animate={false} sessionId="sess-1" />,
    );
    expectNoChip();
    expect(card()).toBeNull();
    expect(screen.queryByText(/detection exploded/)).not.toBeInTheDocument();
  });

  it("splits a surrounding tool group around the card, keeping order", () => {
    const listId = "libi:libi.list_pieces" as McpToolId;
    const msg = message({ result: { result: mcpContent(cardOutput), success: true } });
    msg.parts.splice(1, 0, { type: "tool-call", toolCallId: "tc0", toolId: listId, rawTitle: "mcp__libi__libi_list_pieces", args: {} });
    render(<ChatMessage message={msg} animate={false} sessionId="sess-1" />);
    const chip = screen.getByText(formatToolId(listId));
    expect(chip.compareDocumentPosition(card()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
