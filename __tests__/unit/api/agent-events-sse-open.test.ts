/**
 * The global SSE stream must OPEN even when nothing has happened yet.
 *
 * `GET /api/agent/events` wrote nothing at stream start except a per-active-
 * session "connected" status. With no active session — a fresh boot, or any
 * client that connects before a session is picked — that loop wrote nothing, so
 * no bytes left the server and the response headers were never flushed.
 *
 * The connection was then indistinguishable from a hang:
 *   - `EventSource.onopen` never fires, so the client cannot tell "connected
 *     and idle" from "not connected"
 *   - a fetch/undici consumer blocks on headers until UND_ERR_HEADERS_TIMEOUT
 *
 * Measured 2026-08-02 on a freshly restarted server: 0 bytes in 20s, and a
 * 300s headers timeout for a programmatic consumer.
 *
 * An SSE comment (`: ...`) is ignored by every conforming parser and forces the
 * flush, so the fix costs nothing semantically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveSessionIds = vi.hoisted(() => vi.fn(() => [] as string[]));

vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    getActiveSessionIds,
    onGlobalEvent: vi.fn(),
    offGlobalEvent: vi.fn(),
    onSystemEvent: vi.fn(),
    offSystemEvent: vi.fn(),
  }),
}));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { on: vi.fn(), off: vi.fn() },
}));

async function firstChunk(res: Response, ms = 2000): Promise<string> {
  const reader = res.body!.getReader();
  const timer = new Promise<string>((_, rej) =>
    setTimeout(() => rej(new Error("no bytes flushed — stream never opened")), ms),
  );
  const read = reader.read().then(({ value }) => new TextDecoder().decode(value ?? new Uint8Array()));
  try {
    return await Promise.race([read, timer]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("GET /api/agent/events opens immediately", () => {
  beforeEach(() => {
    getActiveSessionIds.mockReset();
  });

  it("flushes an opening comment with NO active sessions", async () => {
    getActiveSessionIds.mockReturnValue([]);
    const { GET } = await import("@/app/api/agent/events/route");
    const res = await GET(new Request("http://localhost/api/agent/events"));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const chunk = await firstChunk(res);
    expect(
      chunk.startsWith(":"),
      "the first bytes must be an SSE comment so headers flush on an idle stream",
    ).toBe(true);
  });

  it("still flushes when sessions ARE active (no regression)", async () => {
    getActiveSessionIds.mockReturnValue(["sess-1"]);
    const { GET } = await import("@/app/api/agent/events/route");
    const res = await GET(new Request("http://localhost/api/agent/events"));
    const chunk = await firstChunk(res);
    expect(chunk.length).toBeGreaterThan(0);
  });

  it("does not emit a data: frame before any real event", async () => {
    // The opening flush must not look like an event to consumers.
    getActiveSessionIds.mockReturnValue([]);
    const { GET } = await import("@/app/api/agent/events/route");
    const res = await GET(new Request("http://localhost/api/agent/events"));
    const chunk = await firstChunk(res);
    expect(chunk).not.toContain("data:");
  });
});
