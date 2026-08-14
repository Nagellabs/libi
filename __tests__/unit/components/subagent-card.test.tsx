// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentCard } from "@/components/chat/subagent-card";
import type { AgentMessagePart } from "@/lib/agents/message-types";

type SubagentPart = Extract<AgentMessagePart, { type: "subagent" }>;

const RUNNING: SubagentPart = {
  type: "subagent",
  toolCallId: "t1",
  subagentType: "general-purpose",
  description: "Describe 12 frames",
  prompt: "You are describing 12 keyframes…",
  model: "sonnet",
  background: true,
  startedAt: Date.now() - 30_000,
  status: "running",
  result: null,
  usage: null,
  agentId: "abc",
};

describe("SubagentCard", () => {
  it("renders running state with description and model badge", () => {
    render(<SubagentCard part={RUNNING} />);
    expect(screen.getByText("Describe 12 frames")).toBeInTheDocument();
    expect(screen.getByText(/sonnet/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/running/i);
  });

  it("shows duration when completed", () => {
    render(<SubagentCard part={{ ...RUNNING, status: "completed", result: "{}", usage: { durationMs: 61994, totalTokens: 100 } }} />);
    // Duration formatter outputs like "1m 1s" or "61.9s" — accept either.
    expect(screen.getByText(/61\.9\s*s|1\s*m\s*1/)).toBeInTheDocument();
  });

  it("renders failed status with destructive styling", () => {
    render(<SubagentCard part={{ ...RUNNING, status: "failed", result: "boom" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/failed/i);
  });

  it("renders background pill when background is true", () => {
    render(<SubagentCard part={RUNNING} />);
    expect(screen.getByText(/background/i)).toBeInTheDocument();
  });

  it("hides background pill when background is false", () => {
    render(<SubagentCard part={{ ...RUNNING, background: false }} />);
    expect(screen.queryByText(/^background$/i)).not.toBeInTheDocument();
  });

  it("hides model pill when model is null", () => {
    render(<SubagentCard part={{ ...RUNNING, model: null }} />);
    expect(screen.queryByText(/sonnet/i)).not.toBeInTheDocument();
  });
});
