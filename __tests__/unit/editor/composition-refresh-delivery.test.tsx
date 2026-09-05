// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";

// EventSource is not available in jsdom — stub it before the hook module
// loads so the module-level singleton initialisation in use-agent-chat
// succeeds when refreshQueryEmitter is imported from there. Mirrors
// __tests__/unit/hooks/use-global-refresh-query-subscription.test.tsx.
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

const { refreshQueryEmitter } = await import("@/hooks/sessions/use-agent-chat");
const { useCompositionRefreshSubscription } = await import(
  "@/hooks/editor/use-composition-refresh-subscription"
);
const { pieceKeys } = await import("@/lib/queries/pieces");

function mount(qc: QueryClient, onComposition?: (event: unknown) => void) {
  return renderHook(() => useCompositionRefreshSubscription(onComposition), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

describe("useCompositionRefreshSubscription", () => {
  it("invalidates composition + composition-snapshot when 'composition' + pieceId arrives", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);

    refreshQueryEmitter.emit({ queryKey: "composition", pieceId: "abc" });

    expect(spy).toHaveBeenCalledWith({
      queryKey: pieceKeys.composition("abc"),
    });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["composition-snapshot", "abc"],
    });
  });

  it("does nothing on 'composition' with no pieceId", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);

    refreshQueryEmitter.emit({ queryKey: "composition" });

    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing on a non-composition key (the global dispatcher owns it)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);

    refreshQueryEmitter.emit({ queryKey: "pieces" });

    expect(spy).not.toHaveBeenCalled();
  });

  it("REGRESSION: invalidates composition with ZERO useAgentChat instances mounted", () => {
    // This is the bug: composition invalidation used to be delivered ONLY
    // through <ChatPanel onRefreshQuery=…>, which is never mounted on the
    // terminal chat surface (app/(app)/editor/page.tsx renders
    // <TerminalPanel> instead of <ChatPanel> when
    // activeProviderId === "terminal"). No useAgentChat instance exists
    // anywhere in this test — only the module-level refreshQueryEmitter
    // singleton and this hook's own subscription — yet the event must
    // still invalidate the composition caches.
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    mount(qc);

    refreshQueryEmitter.emit({ queryKey: "composition", pieceId: "xyz" });

    expect(spy).toHaveBeenCalledWith({
      queryKey: pieceKeys.composition("xyz"),
    });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["composition-snapshot", "xyz"],
    });
  });

  it("also invokes the onComposition callback for navigation side effects", () => {
    const qc = new QueryClient();
    const onComposition = vi.fn();
    mount(qc, onComposition);

    refreshQueryEmitter.emit({ queryKey: "composition", pieceId: "abc", sceneId: "scene-1" });

    expect(onComposition).toHaveBeenCalledWith({
      queryKey: "composition",
      pieceId: "abc",
      sceneId: "scene-1",
    });
  });

  it("unsubscribes on unmount", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { unmount } = mount(qc);
    unmount();

    refreshQueryEmitter.emit({ queryKey: "composition", pieceId: "abc" });

    expect(spy).not.toHaveBeenCalled();
  });
});
