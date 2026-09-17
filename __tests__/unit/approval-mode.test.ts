import { describe, it, expect } from "vitest";
import { shouldPromptForAcp, isApprovalMode } from "@/lib/approval/mode";

describe("approval-mode predicates", () => {
  it("ask: prompts for ACP", () => {
    expect(shouldPromptForAcp("ask")).toBe(true);
  });

  it("auto and auto-with-generations: skip ACP prompts", () => {
    expect(shouldPromptForAcp("auto")).toBe(false);
    expect(shouldPromptForAcp("auto-with-generations")).toBe(false);
  });

  it("isApprovalMode validates mode strings", () => {
    expect(isApprovalMode("ask")).toBe(true);
    expect(isApprovalMode("auto")).toBe(true);
    expect(isApprovalMode("auto-with-generations")).toBe(true);
    expect(isApprovalMode("nope")).toBe(false);
    expect(isApprovalMode(undefined)).toBe(false);
  });
});
