import { describe, it, expect, afterEach } from "vitest";
import {
  navigationEmitter,
  type RefreshQueryEvent,
} from "@/lib/navigation-events";

/**
 * Contract test for the `refresh_query` event on `navigationEmitter`.
 *
 * This verifies the producer/consumer contract used by the SSE route
 * (`app/api/agent/events/route.ts`) without spinning up the full Next.js
 * server. The MCP server wrappers fire `navigationEmitter.emit("refresh_query", …)`
 * after successful mutations; the SSE route subscribes to the same channel
 * and forwards payloads to the browser.
 */
describe("navigationEmitter refresh_query channel", () => {
  const listeners: Array<(payload: RefreshQueryEvent) => void> = [];

  afterEach(() => {
    for (const l of listeners) {
      navigationEmitter.off("refresh_query", l);
    }
    listeners.length = 0;
  });

  it("delivers emitted refresh_query payloads to subscribers", async () => {
    const received: RefreshQueryEvent[] = [];
    const listener = (payload: RefreshQueryEvent) => {
      received.push(payload);
    };
    listeners.push(listener);
    navigationEmitter.on("refresh_query", listener);

    navigationEmitter.emit("refresh_query", {
      queryKey: "composition",
      pieceId: "p1",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ queryKey: "composition", pieceId: "p1" });
  });

  it("supports payloads without pieceId (global refresh)", () => {
    const received: RefreshQueryEvent[] = [];
    const listener = (payload: RefreshQueryEvent) => {
      received.push(payload);
    };
    listeners.push(listener);
    navigationEmitter.on("refresh_query", listener);

    navigationEmitter.emit("refresh_query", { queryKey: "pieces" });

    expect(received).toHaveLength(1);
    expect(received[0].queryKey).toBe("pieces");
    expect(received[0].pieceId).toBeUndefined();
  });

  it("multiple subscribers each receive emitted events", () => {
    const a: RefreshQueryEvent[] = [];
    const b: RefreshQueryEvent[] = [];
    const la = (p: RefreshQueryEvent) => a.push(p);
    const lb = (p: RefreshQueryEvent) => b.push(p);
    listeners.push(la, lb);
    navigationEmitter.on("refresh_query", la);
    navigationEmitter.on("refresh_query", lb);

    navigationEmitter.emit("refresh_query", {
      queryKey: "piece",
      pieceId: "p1",
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual(b[0]);
  });

  it("RefreshQueryEvent type allows optional pieceId", () => {
    // Pure type-level assertion — these just need to compile.
    const withPiece: RefreshQueryEvent = {
      queryKey: "composition",
      pieceId: "p1",
    };
    const withoutPiece: RefreshQueryEvent = { queryKey: "pieces" };
    expect(withPiece.queryKey).toBe("composition");
    expect(withoutPiece.pieceId).toBeUndefined();
  });
});
