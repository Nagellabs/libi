import { describe, it, expect } from "vitest";
import { recentPieces, RECENT_PIECES_LIMIT } from "@/lib/pieces/recent";

const p = (
  id: string,
  lastOpenedAt: string | null,
  updatedAt = "2026-01-01T00:00:00.000Z",
) => ({ id, lastOpenedAt, updatedAt });

describe("recentPieces", () => {
  it("orders by last opened, newest first", () => {
    const out = recentPieces([
      p("old", "2026-01-01T00:00:00.000Z"),
      p("newest", "2026-03-01T00:00:00.000Z"),
      p("middle", "2026-02-01T00:00:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["newest", "middle", "old"]);
  });

  it("caps at five by default", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      p(`p${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    expect(recentPieces(many)).toHaveLength(RECENT_PIECES_LIMIT);
    expect(RECENT_PIECES_LIMIT).toBe(5);
  });

  it("ranks a never-opened piece BELOW an opened one, however stale the open", () => {
    // The whole point of the ordering: "where was I" beats "what changed".
    // A piece opened two years ago still outranks one the agent touched a
    // second ago but nobody has ever looked at.
    const out = recentPieces([
      p("never-opened-but-just-edited", null, "2026-08-04T12:00:00.000Z"),
      p("opened-long-ago", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual([
      "opened-long-ago",
      "never-opened-but-just-edited",
    ]);
  });

  it("still lists never-opened pieces — an all-agent-created install must not see an empty list", () => {
    // This is the install the feature exists for: pieces exist, none has ever
    // been opened. Returning [] here would leave the user with no answer to
    // "what do I click".
    const out = recentPieces([
      p("a", null, "2026-01-01T00:00:00.000Z"),
      p("b", null, "2026-02-01T00:00:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("falls back to updatedAt when two pieces were opened at the same instant", () => {
    const same = "2026-05-05T05:05:05.000Z";
    const out = recentPieces([
      p("stale", same, "2026-01-01T00:00:00.000Z"),
      p("fresh", same, "2026-06-01T00:00:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["fresh", "stale"]);
  });

  it("treats an unparseable timestamp as absent rather than throwing or NaN-sorting", () => {
    const out = recentPieces([
      p("garbage", "not-a-date", "2026-01-01T00:00:00.000Z"),
      p("real", "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["real", "garbage"]);
  });

  it("does not mutate its input", () => {
    const input = [p("a", "2026-01-01T00:00:00.000Z"), p("b", "2026-03-01T00:00:00.000Z")];
    const before = input.map((x) => x.id);
    recentPieces(input);
    expect(input.map((x) => x.id)).toEqual(before);
  });

  it("returns an empty list for an empty input or a zero limit", () => {
    expect(recentPieces([])).toEqual([]);
    expect(recentPieces([p("a", null)], 0)).toEqual([]);
  });
});
