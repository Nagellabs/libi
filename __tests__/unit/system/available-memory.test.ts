import { describe, it, expect } from "vitest";
import { parseVmStatAvailable } from "@/lib/system/available-memory";

describe("parseVmStatAvailable", () => {
  // Real-world sample from an Apple Silicon Mac (16 KB pages). The
  // numbers below should sum to:
  //   free(62505) + inactive(906580) + speculative(102195) + purgeable(21522)
  //   = 1_092_802 pages * 16384 = 17_904_472_064 bytes (~16.7 GB)
  const APPLE_SILICON_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               62505.
Pages active:                           1003291.
Pages inactive:                          906580.
Pages speculative:                       102195.
Pages throttled:                              0.
Pages wired down:                        512439.
Pages purgeable:                          21522.
"Translation faults":               42349219982.
`;

  it("sums free + inactive + speculative + purgeable pages on Apple Silicon", () => {
    const bytes = parseVmStatAvailable(APPLE_SILICON_SAMPLE);
    const expectedPages = 62505 + 906580 + 102195 + 21522;
    expect(bytes).toBe(expectedPages * 16384);
    // Sanity: this should be in the GB range, not the MB range — that's
    // the whole point of the helper.
    expect(bytes! / 1024 / 1024 / 1024).toBeGreaterThan(10);
  });

  it("uses the page size from the header (4 KB Intel Macs)", () => {
    const intelSample = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               1000.
Pages inactive:                           2000.
Pages speculative:                          0.
Pages purgeable:                            0.
`;
    expect(parseVmStatAvailable(intelSample)).toBe(3000 * 4096);
  });

  it("permissively handles missing optional buckets (speculative/purgeable)", () => {
    // Some minimal builds report only free + inactive. The helper should
    // still return something rather than failing — kernel will keep us
    // honest if we under-count, and over-counting wasn't the bug.
    const minimal = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              500.
Pages inactive:                          1500.
`;
    expect(parseVmStatAvailable(minimal)).toBe(2000 * 4096);
  });

  it("returns null when the page-size header is missing", () => {
    expect(
      parseVmStatAvailable("Pages free: 100.\nPages inactive: 200.\n"),
    ).toBeNull();
  });

  it("returns null when even the free bucket is missing", () => {
    // Without a known floor we can't make a meaningful claim — let the
    // caller fall back to os.freemem().
    const missingFree = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages inactive:                          906580.
`;
    expect(parseVmStatAvailable(missingFree)).toBeNull();
  });

  it("returns null when page size is non-numeric or zero", () => {
    const bad = `Mach Virtual Memory Statistics: (page size of 0 bytes)
Pages free: 100.
`;
    expect(parseVmStatAvailable(bad)).toBeNull();
  });
});
