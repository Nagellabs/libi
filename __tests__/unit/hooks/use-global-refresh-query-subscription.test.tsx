// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";

// EventSource is not available in jsdom — stub it before the hook module
// loads so the module-level singleton initialisation in use-agent-chat
// succeeds when refreshQueryEmitter is imported from there. We capture
// the last-created instance on the constructor so tests can fire
// synthetic messages directly through the singleton's onmessage handler
// without mounting any useAgentChat instance.
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
}
vi.stubGlobal("EventSource", MockEventSource);

const { refreshQueryEmitter, subscribeBroadcast } = await import(
  "@/hooks/sessions/use-agent-chat"
);
const { useGlobalRefreshQuerySubscription } = await import(
  "@/hooks/use-global-refresh-query-subscription"
);
const { pieceKeys } = await import("@/lib/queries/pieces");
const { fileKeys } = await import("@/lib/queries/files");

function mount(qc: QueryClient) {
  return renderHook(() => useGlobalRefreshQuerySubscription(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

describe("useGlobalRefreshQuerySubscription", () => {
  it("invalidates pieceKeys.all when 'pieces' event arrives", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);
    refreshQueryEmitter.emit({ queryKey: "pieces" });
    expect(spy).toHaveBeenCalledWith({ queryKey: pieceKeys.all });
  });

  it("invalidates fileKeys.global() when 'files' event arrives (no pieceId)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);
    refreshQueryEmitter.emit({ queryKey: "files" });
    expect(spy).toHaveBeenCalledWith({ queryKey: fileKeys.global() });
  });

  it("invalidates piece detail + all + per-piece files when 'piece' event arrives", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);
    refreshQueryEmitter.emit({ queryKey: "piece", pieceId: "abc" });
    expect(spy).toHaveBeenCalledWith({ queryKey: pieceKeys.detail("abc") });
    expect(spy).toHaveBeenCalledWith({ queryKey: pieceKeys.all });
    expect(spy).toHaveBeenCalledWith({ queryKey: fileKeys.forPiece("abc") });
  });

  it("does not invalidate on 'composition' (editor owns it)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);
    refreshQueryEmitter.emit({ queryKey: "composition", pieceId: "abc" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { unmount } = mount(qc);
    unmount();
    refreshQueryEmitter.emit({ queryKey: "pieces" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits refreshQueryEmitter from SSE singleton without any useAgentChat instance", () => {
    // Regression: previously the per-instance sseHandler called
    // refreshQueryEmitter.emit. On routes that mount AppSidebar but no
    // chat (e.g. /settings, /characters, /items),
    // usePendingApprovalCount opens the SSE singleton but no
    // per-instance handler is registered — so refresh_query events
    // never reached the layout subscriber. Verify the emit now happens
    // at the singleton-level onmessage handler.
    MockEventSource.instances.length = 0;

    // Open the SSE singleton via subscribeBroadcast (mirrors how
    // usePendingApprovalCount opens it without registering any
    // per-session message handler).
    const unsub = subscribeBroadcast(() => {});
    const es = MockEventSource.instances.at(-1);
    expect(es).toBeDefined();
    expect(typeof es!.onmessage).toBe("function");

    const received: Array<{ queryKey: string; pieceId?: string }> = [];
    const off = refreshQueryEmitter.on((e) => {
      received.push({ queryKey: e.queryKey, pieceId: e.pieceId });
    });

    // Fire a synthetic SSE message at the singleton.
    es!.onmessage!(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "refresh_query", queryKey: "pieces" }),
      }),
    );

    expect(received).toEqual([{ queryKey: "pieces", pieceId: undefined }]);

    off();
    unsub();
  });
});
