import { describe, it, expect } from "vitest";
import { mergeChatMessages } from "@/hooks/sessions/use-agent-chat";

type Msg = { id: string; content: string; isSystemContext?: boolean };

describe("mergeChatMessages", () => {
  it("returns cached then live when there are no id collisions", () => {
    const cached: Msg[] = [
      { id: "a", content: "cached-a" },
      { id: "b", content: "cached-b" },
    ];
    const live: Msg[] = [{ id: "c", content: "live-c" }];
    expect(mergeChatMessages(cached, live).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops cached duplicates when live carries the same id (live wins)", () => {
    // Regression: client + server both mint `agent_${Date.now()}_${counter}`
    // IDs from independent counters. When they collide, the cached copy
    // (from /api/agent/messages) and the live copy (from SSE) shared the
    // same key and triggered "Encountered two children with the same key"
    // warnings. After dedup, only the live copy survives.
    const cached: Msg[] = [
      { id: "agent_TS_3", content: "stale-from-cache" },
      { id: "user_1", content: "ok" },
    ];
    const live: Msg[] = [
      { id: "agent_TS_3", content: "in-flight-live" },
    ];
    const merged = mergeChatMessages(cached, live);
    expect(merged.map((m) => m.id)).toEqual(["user_1", "agent_TS_3"]);
    expect(merged.find((m) => m.id === "agent_TS_3")?.content).toBe(
      "in-flight-live",
    );
  });

  it("filters out isSystemContext messages from either bucket", () => {
    const cached: Msg[] = [
      { id: "sysC", content: "x", isSystemContext: true },
      { id: "a", content: "cached" },
    ];
    const live: Msg[] = [
      { id: "sysL", content: "y", isSystemContext: true },
      { id: "b", content: "live" },
    ];
    expect(mergeChatMessages(cached, live).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("handles both buckets empty", () => {
    expect(mergeChatMessages([], [])).toEqual([]);
  });

  it("multiple id collisions: every duplicate drops the cached side", () => {
    const cached: Msg[] = [
      { id: "x1", content: "cx1" },
      { id: "x2", content: "cx2" },
      { id: "kept", content: "ck" },
    ];
    const live: Msg[] = [
      { id: "x1", content: "lx1" },
      { id: "x2", content: "lx2" },
    ];
    expect(mergeChatMessages(cached, live)).toEqual([
      { id: "kept", content: "ck" },
      { id: "x1", content: "lx1" },
      { id: "x2", content: "lx2" },
    ]);
  });
});
