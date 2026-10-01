import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markInstalling,
  clearInstalling,
  isInstalling,
  _resetInFlight,
} from "@/lib/mcp-virtual-deps/in-flight";

beforeEach(() => _resetInFlight());

describe("in-flight virtual-dep tracker", () => {
  it("isInstalling false by default", () => {
    expect(isInstalling("ace-step-env")).toBe(false);
  });

  it("markInstalling sets the flag", () => {
    markInstalling("ace-step-env");
    expect(isInstalling("ace-step-env")).toBe(true);
  });

  it("clearInstalling unsets the flag", () => {
    markInstalling("ace-step-env");
    clearInstalling("ace-step-env");
    expect(isInstalling("ace-step-env")).toBe(false);
  });

  it("multiple ids tracked independently", () => {
    markInstalling("a");
    markInstalling("b");
    clearInstalling("a");
    expect(isInstalling("a")).toBe(false);
    expect(isInstalling("b")).toBe(true);
  });
});

// A production Next build bundles the retry-dep route and each VirtualDep.inspect()
// caller apart, so each loads its own copy of this module. Before this fix, a mark made
// in one copy was invisible to the other — the class of bug d2f3ea41 fixed for
// lib/agents/acp/agent-registry.ts.
describe("in-flight state across module copies (a production build loads the route and the caller apart)", () => {
  it("a mark in one copy is read by a copy loaded separately", async () => {
    vi.resetModules();
    const a = await import("@/lib/mcp-virtual-deps/in-flight");
    a.markInstalling("x");

    vi.resetModules();
    const b = await import("@/lib/mcp-virtual-deps/in-flight");
    expect(b).not.toBe(a);
    expect(b.isInstalling("x")).toBe(true);

    b.clearInstalling("x");
    expect(a.isInstalling("x")).toBe(false);
    a.clearInstalling("x");
  });
});
