/**
 * Unit: selectProxiesToEvict — pick the oldest proxies to drop when the
 * total proxy footprint exceeds the budget.
 *
 * LRU is by `proxyGeneratedAt` (oldest evicted first). In-use proxies
 * (attached to an open piece) are protected by a boolean flag.
 */
import { describe, it, expect } from "vitest";
import { selectProxiesToEvict, type ProxyEntry } from "@/lib/proxy/lru";

function mk(
  id: string,
  bytes: number,
  generatedAt: number,
  inUse = false,
): ProxyEntry {
  return { fileId: id, bytes, generatedAt, inUse };
}

describe("selectProxiesToEvict", () => {
  it("returns empty when under budget", () => {
    const entries = [mk("a", 100, 1), mk("b", 100, 2)];
    expect(selectProxiesToEvict(entries, 1000)).toEqual([]);
  });

  it("evicts the oldest first", () => {
    const entries = [mk("a", 100, 3), mk("b", 100, 1), mk("c", 100, 2)];
    expect(selectProxiesToEvict(entries, 100)).toEqual(["b", "c"]);
  });

  it("protects in-use entries", () => {
    const entries = [mk("a", 100, 1, true), mk("b", 100, 2)];
    expect(selectProxiesToEvict(entries, 100)).toEqual(["b"]);
  });

  it("evicts in-use only if all non-in-use are gone and still over budget", () => {
    const entries = [mk("a", 100, 1, true), mk("b", 100, 2, true)];
    expect(selectProxiesToEvict(entries, 100)).toEqual(["a"]);
  });

  it("returns exactly enough to drop under budget (not more)", () => {
    const entries = [
      mk("a", 50, 1),
      mk("b", 50, 2),
      mk("c", 50, 3),
      mk("d", 50, 4),
    ];
    // Budget 100 total; we have 200. Need to drop 100 worth → 2 oldest.
    expect(selectProxiesToEvict(entries, 100)).toEqual(["a", "b"]);
  });
});
