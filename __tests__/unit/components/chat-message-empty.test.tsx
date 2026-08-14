// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ChatMessage from "@/components/chat/chat-message";
import type { AgentMessage } from "@/hooks/sessions/use-agent-chat";

describe("ChatMessage — empty agent message (gap fix)", () => {
  it("renders nothing for an agent message with no renderable parts", () => {
    const msg: AgentMessage = {
      id: "agent_empty_1",
      role: "agent",
      parts: [],
      timestamp: Date.now(),
      isStreaming: false,
    };
    const { container } = render(<ChatMessage message={msg} />);
    // No wrapper, no timestamp footer — the empty placeholder was the
    // "big gap" between the user note and the eventual reply.
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders a normal user text message", () => {
    const msg: AgentMessage = {
      id: "user_1",
      role: "user",
      parts: [{ type: "text", text: "[manual edit] Re-anchored at 0:17." }],
      timestamp: Date.now(),
    };
    const { getByText } = render(<ChatMessage message={msg} />);
    expect(getByText(/Re-anchored at 0:17\./)).toBeInTheDocument();
  });
});
