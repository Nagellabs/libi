import { describe, it, expect } from "vitest";
import {
  shouldPromptForAcp,
  shouldPromptForGeneration,
  isApprovalMode,
} from "@/lib/approval/mode";

describe("approval-mode predicates", () => {
  it("ask: prompts for both ACP and generation", () => {
    expect(shouldPromptForAcp("ask")).toBe(true);
    expect(shouldPromptForGeneration("ask")).toBe(true);
  });

  it("auto: skips ACP, prompts for generation", () => {
    expect(shouldPromptForAcp("auto")).toBe(false);
    expect(shouldPromptForGeneration("auto")).toBe(true);
  });

  it("auto-with-generations: skips both", () => {
    expect(shouldPromptForAcp("auto-with-generations")).toBe(false);
    expect(shouldPromptForGeneration("auto-with-generations")).toBe(false);
  });

  it("isApprovalMode validates mode strings", () => {
    expect(isApprovalMode("ask")).toBe(true);
    expect(isApprovalMode("auto")).toBe(true);
    expect(isApprovalMode("auto-with-generations")).toBe(true);
    expect(isApprovalMode("nope")).toBe(false);
    expect(isApprovalMode(undefined)).toBe(false);
  });
});
