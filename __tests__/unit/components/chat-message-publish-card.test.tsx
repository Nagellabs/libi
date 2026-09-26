// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ChatMessage from "@/components/chat/chat-message";
import type { AgentMessage } from "@/hooks/sessions/use-agent-chat";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { extractPublishRequest, publishReviewHref } from "@/lib/chat/publish-request";

/**
 * `libi.publish_template` only prepares a publish. Once its result says
 * `awaiting_your_confirmation`, the chat shows "Ready to publish ‹name›" with a
 * link to that request's review panel on the Templates page — the only place
 * the user can publish it. The tool chip stays.
 */
const TOOL_ID = "libi:libi.publish_template" as McpToolId;
const TITLE = "mcp__libi__libi_publish_template";
const awaiting = {
  success: true,
  data: {
    status: "awaiting_your_confirmation",
    requestId: "req-1",
    templateId: "t1",
    name: "Monday reset hook",
    message: "Ready for you to publish. Open Templates in libi and click Publish — I can't publish it for you.",
  },
};
const content = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

function message(result?: { result: unknown; success: boolean }, toolId: McpToolId | null = TOOL_ID): AgentMessage {
  return {
    id: "m1",
    role: "agent",
    timestamp: Date.now(),
    isStreaming: false,
    parts: [
      { type: "tool-call", toolCallId: "tc1", toolId, rawTitle: TITLE, args: {} },
      ...(result ? [{ type: "tool-result" as const, toolCallId: "tc1", toolId, rawTitle: TITLE, ...result }] : []),
      { type: "text", text: "Ready for you to publish on the Templates page." },
    ],
  };
}
const renderMsg = (m: AgentMessage) => render(<ChatMessage message={m} animate={false} sessionId="s1" />);

describe("ChatMessage — the publish request card", () => {
  it("an awaiting result shows the card, linking to the request's review panel", () => {
    renderMsg(message({ result: content(awaiting), success: true }));
    const card = screen.getByTestId("publish-request-card");
    expect(card).toHaveTextContent("Ready to publish “Monday reset hook”");
    expect(card).toHaveTextContent("Nothing is public yet");
    const link = screen.getByTestId("publish-request-card-review");
    expect(link).toHaveTextContent("Review and publish");
    expect(link).toHaveAttribute("href", "/templates?tab=mine&review=req-1");
    expect(link).toHaveClass("cursor-pointer");
  });

  it("no card before the result, for a refusal, or for an error", () => {
    renderMsg(message());
    expect(screen.queryByTestId("publish-request-card")).toBeNull();
    for (const result of [
      { result: content({ success: false, data: { error: "nickname missing" } }), success: true },
      { result: { isError: true, content: [] }, success: true },
      { result: content(awaiting), success: false },
    ]) {
      const { unmount } = renderMsg(message(result));
      expect(screen.queryByTestId("publish-request-card")).toBeNull();
      unmount();
    }
  });

  it("reads the canonical id first, the raw title only without one", () => {
    expect(extractPublishRequest({ toolId: TOOL_ID }, { result: content(awaiting), success: true })).toEqual({ requestId: "req-1", name: "Monday reset hook" });
    expect(extractPublishRequest({ toolId: null, rawTitle: TITLE }, { result: content(awaiting), success: true })).toEqual({ requestId: "req-1", name: "Monday reset hook" });
    expect(extractPublishRequest({ toolId: "libi:libi.apply_template" as McpToolId }, { result: content(awaiting), success: true })).toBeNull();
    expect(publishReviewHref({ requestId: "a b", name: "" })).toBe("/templates?tab=mine&review=a%20b");
  });
});
