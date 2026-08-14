import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  fetchLiveAnnouncements,
  clearAnnouncementsCache,
} from "@/lib/announcements/site-client";

const VALID = {
  id: "a1",
  title: "T",
  body: "B",
  kind: "feature",
  url: null,
  createdAt: "2026-08-12T00:00:00.000Z",
};

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  } as unknown as Response);
}

describe("announcements site-client", () => {
  beforeEach(() => clearAnnouncementsCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped announcements and caches the result", async () => {
    const spy = mockFetchOnce({ ok: true, announcements: [VALID] });
    expect(await fetchLiveAnnouncements()).toHaveLength(1);
    expect(await fetchLiveAnnouncements()).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sorts newest first regardless of upstream order", async () => {
    mockFetchOnce({
      ok: true,
      announcements: [
        { ...VALID, id: "old", createdAt: "2026-08-10T00:00:00.000Z" },
        { ...VALID, id: "new", createdAt: "2026-08-12T00:00:00.000Z" },
      ],
    });
    const result = await fetchLiveAnnouncements();
    expect(result.map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("drops malformed entries and coerces unknown kind to feature", async () => {
    mockFetchOnce({
      ok: true,
      announcements: [
        { ...VALID, kind: "shout" },
        { id: "bad" },
        "not-an-object",
      ],
    });
    const result = await fetchLiveAnnouncements();
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("feature");
  });

  it("drops unsafe or malformed urls but keeps a valid https url", async () => {
    mockFetchOnce({
      ok: true,
      announcements: [
        { ...VALID, id: "js", url: "javascript:alert(1)" },
        { ...VALID, id: "not-a-url", url: "not a url" },
        { ...VALID, id: "https", url: "https://libi.nagellabs.com" },
      ],
    });
    const result = await fetchLiveAnnouncements();
    const byId = Object.fromEntries(result.map((a) => [a.id, a.url]));
    expect(byId.js).toBeNull();
    expect(byId["not-a-url"]).toBeNull();
    expect(byId.https).toBe("https://libi.nagellabs.com");
  });

  it("returns [] on non-200 and does NOT cache the failure", async () => {
    const spy = mockFetchOnce({ ok: false }, false, 503);
    expect(await fetchLiveAnnouncements()).toEqual([]);
    expect(await fetchLiveAnnouncements()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns [] when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await fetchLiveAnnouncements()).toEqual([]);
  });

  it("returns a defensive copy so mutations do not corrupt the cache", async () => {
    const spy = mockFetchOnce({
      ok: true,
      announcements: [
        { ...VALID, id: "a" },
        { ...VALID, id: "b" },
      ],
    });
    const first = await fetchLiveAnnouncements();
    expect(first).toHaveLength(2);
    first.pop(); // Mutate the returned array
    const second = await fetchLiveAnnouncements(); // Still within TTL (cache hit)
    expect(spy).toHaveBeenCalledTimes(1); // No second fetch
    expect(second).toHaveLength(2); // Original cache is unmutated
    expect(second.map((a) => a.id)).toEqual(["b", "a"]); // Original order preserved
  });
});
