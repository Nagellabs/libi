// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ChatMessage from "@/components/chat/chat-message";
import type { AgentMessage } from "@/hooks/sessions/use-agent-chat";

/**
 * End-to-end integration of the inline chat-media path: a realistic
 * show_in_chat tool-call + tool-result (as the chat reducer shapes them, using
 * the MCP-namespaced tool id the live agent carries) must render a
 * ChatMediaCard inline AND suppress the raw tool chip — no agent in the loop.
 */
function mediaMessage(toolId: string): AgentMessage {
  return {
    id: "agent_media_1",
    role: "agent",
    timestamp: Date.now(),
    isStreaming: false,
    parts: [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolId,
        rawTitle: toolId,
        args: { fileId: "f1", caption: "End-to-end QA" },
      },
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolId,
        rawTitle: toolId,
        success: true,
        // The REAL shape the chat reducer stores for an MCP tool result: a
        // content array whose text is the JSON-stringified tool output.
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                data: {
                  chatMedia: {
                    fileId: "f1",
                    kind: "image",
                    contentType: "image/png",
                    filename: "shot.png",
                    caption: "End-to-end QA",
                  },
                },
              }),
            },
          ],
        },
      },
    ],
  } as unknown as AgentMessage;
}

describe("ChatMessage — inline show_in_chat media (end-to-end render)", () => {
  it("renders the media card and suppresses the tool chip (MCP-namespaced id)", () => {
    const { container, queryByText } = render(
      <ChatMessage
        message={mediaMessage("mcp__libi__libi_show_in_chat")}
        animate={false}
        sessionId="s1"
      />,
    );
    const img = container.querySelector('img[src="/api/files/by-id/f1/content"]');
    expect(img).toBeInTheDocument();
    // raw tool chip suppressed — the card replaces it
    expect(queryByText(/show_in_chat/i)).not.toBeInTheDocument();
  });

  it("also works with the colon-form tool id", () => {
    const { container } = render(
      <ChatMessage
        message={mediaMessage("libi:show_in_chat")}
        animate={false}
        sessionId="s1"
      />,
    );
    expect(
      container.querySelector('img[src="/api/files/by-id/f1/content"]'),
    ).toBeInTheDocument();
  });
});
