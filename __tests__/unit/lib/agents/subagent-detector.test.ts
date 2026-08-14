import { describe, it, expect } from "vitest";
import { isSubagentDispatch, parseSubagentDispatch, parseSubagentCompletion, extractAgentId } from "@/lib/agents/subagent-detector";

describe("isSubagentDispatch", () => {
  it("matches Task tool", () => {
    expect(isSubagentDispatch("Task")).toBe(true);
    expect(isSubagentDispatch("Agent")).toBe(true);
  });
  it("does not match other tools", () => {
    expect(isSubagentDispatch("Read")).toBe(false);
    expect(isSubagentDispatch("libi.create_scene")).toBe(false);
  });
});

describe("parseSubagentDispatch", () => {
  it("extracts fields from a typical Task input", () => {
    const result = parseSubagentDispatch({
      description: "Describe 12 frames",
      subagent_type: "general-purpose",
      model: "sonnet",
      run_in_background: true,
      prompt: "You are describing 12 keyframes...",
    });
    expect(result).toEqual({
      description: "Describe 12 frames",
      subagentType: "general-purpose",
      model: "sonnet",
      background: true,
      prompt: "You are describing 12 keyframes...",
    });
  });
  it("defaults model to null and background to false when absent", () => {
    const result = parseSubagentDispatch({
      description: "x",
      subagent_type: "Explore",
      prompt: "y",
    });
    expect(result?.model).toBeNull();
    expect(result?.background).toBe(false);
  });
  it("returns null for invalid input", () => {
    expect(parseSubagentDispatch(null)).toBeNull();
    expect(parseSubagentDispatch({})).toBeNull();
    expect(parseSubagentDispatch({ description: "x" })).toBeNull(); // missing subagent_type
  });
});

describe("parseSubagentCompletion", () => {
  it("parses a <task-notification> result block", () => {
    const raw =
      "<task-notification><status>completed</status><result>{\"ok\":1}</result>" +
      "<usage>total_tokens: 29888\ntool_uses: 12\nduration_ms: 61994</usage>" +
      "</task-notification>";
    const parsed = parseSubagentCompletion(raw);
    expect(parsed).toEqual({
      status: "completed",
      result: '{"ok":1}',
      usage: { totalTokens: 29888, toolUses: 12, durationMs: 61994 },
    });
  });
  it("returns null when string is not a task-notification", () => {
    expect(parseSubagentCompletion("Async agent launched successfully.\nagentId: abc")).toBeNull();
  });
});

describe("extractAgentId", () => {
  it("extracts the agentId from an ack message", () => {
    expect(extractAgentId("Async agent launched successfully.\nagentId: a02a7670feede2f04 ...")).toBe("a02a7670feede2f04");
  });
  it("returns null when not present", () => {
    expect(extractAgentId("hello world")).toBeNull();
  });
});
