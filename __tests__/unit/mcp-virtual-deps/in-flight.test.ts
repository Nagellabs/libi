import { describe, it, expect, beforeEach } from "vitest";
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
