/**
 * Integration: /api/notify POST → /api/agent/events SSE stream.
 *
 * Invokes both Next.js route handlers directly (no server needed), opens
 * an SSE reader, fires a POST to /api/notify, and asserts the event is
 * serialized onto the stream in the exact shape the browser expects.
 * This is the server-leg half of the "timeline doesn't update" fix —
 * the client-side reader in `use-agent-chat.ts` parses these lines.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub SessionManager — we don't need real sessions for this test.
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    onGlobalEvent: () => {},
    offGlobalEvent: () => {},
    onSystemEvent: () => {},
    offSystemEvent: () => {},
    getActiveSessionIds: () => [] as string[],
  }),
}));

// MCP config invalidation isn't what we're testing here.
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: () => {},
}));

import { GET as eventsGET } from "@/app/api/agent/events/route";
import { POST as notifyPOST } from "@/app/api/notify/route";

async function openSseStream(): Promise<{
  reader: ReadableStreamDefaultReader<string>;
  cancel: () => Promise<void>;
}> {
  const req = new Request("http://localhost/api/agent/events", {
    method: "GET",
  });
  const res = await eventsGET(req);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = res.body!
    .pipeThrough(new TextDecoderStream())
    .getReader();
  // Tests cancel() manually
  return { reader, cancel: () => reader.cancel() };
}

async function postNotify(body: Record<string, unknown>): Promise<Response> {
  return notifyPOST(
    new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readNextEvent(
  reader: ReadableStreamDefaultReader<string>,
  timeoutMs = 500,
): Promise<Record<string, unknown> | null> {
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timeout = new Promise<{ done: boolean; value?: string }>((resolve) =>
      setTimeout(() => resolve({ done: true }), Math.max(0, deadline - Date.now())),
    );
    const r = await Promise.race([readPromise, timeout]);
    if (r.done) return null;
    buffer += r.value ?? "";
    const match = buffer.match(/^data: (.+?)\n\n/m);
    if (match) {
      return JSON.parse(match[1]) as Record<string, unknown>;
    }
  }
  return null;
}

describe("/api/notify → /api/agent/events SSE pipeline", () => {
  let stream: Awaited<ReturnType<typeof openSseStream>>;

  beforeEach(async () => {
    stream = await openSseStream();
  });

  afterEach(async () => {
    try { await stream.cancel(); } catch { /* ignore */ }
  });

  it("forwards a piece-scoped refresh_query", async () => {
    const res = await postNotify({
      type: "refresh_query",
      queryKey: "piece",
      pieceId: "p1",
    });
    expect(res.status).toBe(200);

    const event = await readNextEvent(stream.reader);
    expect(event).toEqual({
      type: "refresh_query",
      queryKey: "piece",
      pieceId: "p1",
    });
  });

  it("forwards navigate events (show_preview target)", async () => {
    const res = await postNotify({
      type: "navigate",
      target: "preview",
      pieceId: "p1",
    });
    expect(res.status).toBe(200);

    const event = await readNextEvent(stream.reader);
    expect(event).toMatchObject({
      type: "navigate",
      target: "preview",
      pieceId: "p1",
    });
  });

  it("rejects unknown notify types with 400", async () => {
    const res = await postNotify({ type: "bogus-nope" });
    expect(res.status).toBe(400);
  });

  it("a second independent SSE subscriber also receives events", async () => {
    const second = await openSseStream();
    try {
      const res = await postNotify({
        type: "refresh_query",
        queryKey: "composition",
        pieceId: "p2",
      });
      expect(res.status).toBe(200);

      const [a, b] = await Promise.all([
        readNextEvent(stream.reader),
        readNextEvent(second.reader),
      ]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({
        type: "refresh_query",
        queryKey: "composition",
        pieceId: "p2",
      });
    } finally {
      await second.cancel();
    }
  });
});
