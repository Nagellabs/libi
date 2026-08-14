import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeMediaMetadata } from "@/lib/utils/media-probe";

describe("probeMediaMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty object for non-media types", async () => {
    const file = new File(["data"], "readme.txt", { type: "text/plain" });
    const result = await probeMediaMetadata(file);
    expect(result).toEqual({});
  });

  it("returns empty object for files with no type", async () => {
    const file = new File(["data"], "mystery");
    const result = await probeMediaMetadata(file);
    expect(result).toEqual({});
  });

  it("returns empty object for application types", async () => {
    const file = new File(["data"], "doc.pdf", { type: "application/pdf" });
    const result = await probeMediaMetadata(file);
    expect(result).toEqual({});
  });
});
