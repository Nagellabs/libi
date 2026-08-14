import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getInstructions } from "@/mcp/instructions";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";

beforeEach(() => {
  createTempStorageDir();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDir();
});

describe("getInstructions test-mode banner", () => {
  it("does NOT include the TEST MODE banner when LIBI_TEST_MODE is unset", () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    const out = getInstructions();
    expect(out).not.toMatch(/TEST MODE ACTIVE/);
  });

  it("includes the TEST MODE banner when LIBI_TEST_MODE=1", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const out = getInstructions();
    expect(out).toMatch(/TEST MODE ACTIVE/);
    // Banner describes the fal-ai masquerade (fake-fal replaces fake-ai-assets)
    expect(out).toMatch(/fal-ai/);
    expect(out).toMatch(/sandboxed fake|placeholder/);
  });

  it("banner appears near the top — before the rest of the instructions body", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const out = getInstructions();
    const bannerIdx = out.indexOf("TEST MODE ACTIVE");
    // Find the first H1/H2 heading line that's NOT inside the banner
    const headingMatch = out.match(/\n##? [^\n]/);
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    if (headingMatch && headingMatch.index !== undefined) {
      // Banner should come before the first ## heading (which marks the body sections)
      expect(bannerIdx).toBeLessThan(headingMatch.index);
    }
  });
});
