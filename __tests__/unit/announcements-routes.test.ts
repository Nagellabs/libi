import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { listSeenIds, markSeen } from "@/lib/announcements/seen-store";
import type { SiteAnnouncement } from "@/lib/announcements/site-client";

const live: SiteAnnouncement[] = [];
vi.mock("@/lib/announcements/site-client", () => ({
  fetchLiveAnnouncements: vi.fn(async () => live),
}));

import { GET } from "@/app/api/announcements/route";
import { POST } from "@/app/api/announcements/seen/route";

function announcement(id: string, createdAt: string): SiteAnnouncement {
  return { id, title: "T " + id, body: "B", kind: "feature", url: null, createdAt };
}

function seenRequest(body: unknown): Request {
  return new Request("http://localhost/api/announcements/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("announcements app routes", () => {
  beforeEach(() => {
    createTestDb();
    live.length = 0;
  });
  afterEach(() => {
    resetTestDb();
  });

  it("GET returns null when nothing is live", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ announcement: null, liveIds: [] });
  });

  it("GET returns the newest unseen announcement with all live ids", async () => {
    live.push(
      announcement("new", "2026-08-12T00:00:00.000Z"),
      announcement("old", "2026-08-10T00:00:00.000Z"),
    );
    const json = await (await GET()).json();
    expect(json.announcement.id).toBe("new");
    expect(json.liveIds).toEqual(["new", "old"]);
  });

  it("GET skips seen announcements (falls through to older unseen)", async () => {
    live.push(
      announcement("new", "2026-08-12T00:00:00.000Z"),
      announcement("old", "2026-08-10T00:00:00.000Z"),
    );
    markSeen(["new"]);
    const json = await (await GET()).json();
    expect(json.announcement.id).toBe("old");
  });

  it("GET returns null when everything live is seen", async () => {
    live.push(announcement("a", "2026-08-12T00:00:00.000Z"));
    markSeen(["a"]);
    const json = await (await GET()).json();
    expect(json.announcement).toBeNull();
    expect(json.liveIds).toEqual(["a"]);
  });

  it("POST seen records ids and answers 204", async () => {
    const res = await POST(seenRequest({ ids: ["x", "y"] }));
    expect(res.status).toBe(204);
    expect(listSeenIds().sort()).toEqual(["x", "y"]);
  });

  it("POST rejects invalid bodies with 400", async () => {
    expect((await POST(seenRequest({ ids: "nope" }))).status).toBe(400);
    expect((await POST(seenRequest({ ids: [""] }))).status).toBe(400);
    expect((await POST(seenRequest({ ids: ["a".repeat(129)] }))).status).toBe(400);
    expect((await POST(seenRequest({ ids: Array.from({ length: 51 }, (_, i) => `i${i}`) }))).status).toBe(400);
    expect(listSeenIds()).toEqual([]);
  });
});
