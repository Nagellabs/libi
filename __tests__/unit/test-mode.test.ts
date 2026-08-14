import { describe, it, expect, afterEach, vi } from "vitest";
import { isTestMode } from "@/lib/test-mode";

afterEach(() => vi.unstubAllEnvs());

describe("isTestMode", () => {
  it("true when LIBI_TEST_MODE=1", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(isTestMode()).toBe(true);
  });
  it("true when LIBI_TEST_MODE=true", () => {
    vi.stubEnv("LIBI_TEST_MODE", "true");
    expect(isTestMode()).toBe(true);
  });
  it("false when env is absent or empty", () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(isTestMode()).toBe(false);
  });
  it("false for any other value", () => {
    vi.stubEnv("LIBI_TEST_MODE", "off");
    expect(isTestMode()).toBe(false);
  });
});
