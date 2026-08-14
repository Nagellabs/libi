import { describe, it, expect } from "vitest";
import { formatProgressCounts } from "@/components/settings/jobs-tab";

describe("formatProgressCounts", () => {
  it("renders large byte counts as MB", () => {
    expect(formatProgressCounts(1_867_624, 1_867_624, "bytes")).toBe("1.9/1.9 MB");
  });
  it("keeps small byte counts raw", () => {
    expect(formatProgressCounts(512, 900_000, "bytes")).toBe("512/900000 bytes");
  });
  it("passes non-byte units through", () => {
    expect(formatProgressCounts(34, 60, "ticks")).toBe("34/60 ticks");
  });
});
