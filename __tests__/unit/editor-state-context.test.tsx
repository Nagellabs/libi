// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  EditorStateProvider,
  useEditorState,
} from "@/lib/editor-state-context";
import { MCP_SCROLL_EVENT, takePendingMcpScroll } from "@/lib/mcp-scroll-intent";

// Mutable box so individual tests can flip `readiness` (and re-render) to
// simulate a connection succeeding mid-session — see the "readiness-driven
// re-read" describe block below. `vi.hoisted` is required because vi.mock's
// factory is hoisted above this file's own top-level statements; a plain
// `let` here would still be in the temporal dead zone when the factory runs.
const sessionListMock = vi.hoisted(() => ({
  current: {
    sessions: [] as unknown[],
    activeSessionId: null as string | null,
    setActiveSessionId: vi.fn(),
    isLoading: false,
    activeAgentId: null as string | null,
    refresh: vi.fn(),
    createSession: vi.fn(),
    // Mirrors UNKNOWN_READINESS from lib/agents/agent-readiness.ts — "nothing
    // attempted yet", never a claim of health.
    readiness: { state: "unknown" } as { state: string; [key: string]: unknown },
  },
}));
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => sessionListMock.current,
}));
// A STABLE router mock: the navigate_agents describe below asserts on the
// pushes libi.show_extension / libi.start_onboarding make, so every
// useRouter() call has to hand back the same spy.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
// SSE broadcasts reach the context through subscribeBroadcast; capturing the
// handler lets a test play an event in.
const broadcast = vi.hoisted(() => ({
  handlers: new Set<(data: Record<string, unknown>) => void>(),
  emit(data: Record<string, unknown>) {
    for (const h of broadcast.handlers) h(data);
  },
}));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: (handler: (data: Record<string, unknown>) => void) => {
    broadcast.handlers.add(handler);
    return () => broadcast.handlers.delete(handler);
  },
}));

beforeEach(() => {
  localStorage.clear();
  broadcast.handlers.clear();
  routerMock.push.mockClear();
  sessionListMock.current = {
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    isLoading: false,
    activeAgentId: null,
    refresh: vi.fn(),
    createSession: vi.fn(),
    readiness: { state: "unknown" },
  };
});

function captureCtx() {
  const { result } = renderHook(() => useEditorState(), {
    wrapper: EditorStateProvider,
  });
  return () => result.current;
}

describe("editor-state-context asset tab + prefill", () => {
  it("accepts and persists a valid lastAssetTab value", () => {
    const get = captureCtx();
    act(() => get().setLastAssetTab("frames"));
    expect(get().lastAssetTab).toBe("frames");
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.lastAssetTab).toBe("frames");
  });

  it("falls back to 'summary' when a persisted lastAssetTab names the removed Script tab", () => {
    // The asset-level "Extra analysis" (script) tab was deleted. A localStorage
    // value written before that must not resurrect a tab that no longer
    // renders — it degrades to the default.
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ lastAssetTab: "script", scriptShotRailPct: 50 }),
    );
    const get = captureCtx();
    expect(get().lastAssetTab).toBe("summary");
    expect("scriptShotRailPct" in get()).toBe(false);
  });

  it("exposes setPrefilledMessage / prefilledMessage", () => {
    const get = captureCtx();
    expect(get().prefilledMessage).toBeNull();
    act(() => get().setPrefilledMessage("Hello"));
    expect(get().prefilledMessage).toBe("Hello");
    act(() => get().setPrefilledMessage(null));
    expect(get().prefilledMessage).toBeNull();
  });
});

describe("timeline split state", () => {
  it("defaults previewTimelineSplit to 72", () => {
    const get = captureCtx();
    expect(get().previewTimelineSplit).toBe(72);
  });

  it("persists previewTimelineSplit changes", () => {
    const get = captureCtx();
    act(() => get().setPreviewTimelineSplit(80));
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.previewTimelineSplit).toBe(80);
  });

  it("clamps stale out-of-range previewTimelineSplit back to default on load", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ previewTimelineSplit: 99 }),
    );
    const get = captureCtx();
    expect(get().previewTimelineSplit).toBe(72);
  });
});

describe("effects panel height", () => {
  it("defaults effectsPanelHeight to 300", () => {
    const get = captureCtx();
    expect(get().effectsPanelHeight).toBe(300);
  });

  it("defaults effectsPanelHeight to 300 and clamps persisted values", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ effectsPanelHeight: 9999 }),
    );
    const get = captureCtx();
    expect(get().effectsPanelHeight).toBeLessThanOrEqual(560);
    expect(get().effectsPanelHeight).toBeGreaterThanOrEqual(200);
  });

  it("persists effectsPanelHeight changes (clamped)", () => {
    const get = captureCtx();
    act(() => get().setEffectsPanelHeight(420));
    expect(get().effectsPanelHeight).toBe(420);
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.effectsPanelHeight).toBe(420);
  });
});

// previewTimelineZoom's lifecycle (transient, in-memory, never persisted —
// see lib/editor-state-context.tsx) is covered by
// __tests__/unit/preview/timeline-zoom-lifecycle.test.tsx. The describe block
// that used to live here asserted the opposite (localStorage persistence),
// which Task 4 deliberately removed as the fix for the reported bug.

/**
 * The provider list handed to consumers must NOT be pre-filtered on
 * `available`. Filtering here is what made Claude Code silently VANISH from
 * the agent selector while its ~212MB adapter was still installing at first
 * boot — the selector now renders unavailable agents disabled with their
 * `unavailableReason`, which it can only do if they reach it at all.
 */
describe("agent providers — unavailable entries survive to the UI", () => {
  const PROVIDERS = [
    {
      id: "claude-code",
      name: "Claude Code",
      available: false,
      capabilities: { canListSessions: true },
      unavailableReason: { code: "installing", message: "Installing…" },
    },
    { id: "codex", name: "Codex", available: true, capabilities: { canListSessions: false } },
  ];

  it("keeps an unavailable provider, with its reason intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => PROVIDERS })),
    );
    const get = captureCtx();

    await vi.waitFor(() => expect(get().agentProvidersLoaded).toBe(true));

    expect(get().agentProviders.map((p) => p.id)).toEqual(["claude-code", "codex"]);
    const claude = get().agentProviders.find((p) => p.id === "claude-code")!;
    expect(claude.available).toBe(false);
    expect(claude.unavailableReason).toEqual({ code: "installing", message: "Installing…" });

    vi.unstubAllGlobals();
  });
});

/**
 * Task 13: the demo offer that vanishes on reload.
 *
 * `onboardingDemoOffer` used to be a bare `useState(false)` — a reload
 * before the user acted on (or dismissed) it lost the offer for good. It's
 * now seeded from, and its resolution persisted back to, the server-side
 * onboarding-state record (lib/db/settings.ts, app/api/onboarding/state).
 */
describe("onboarding demo offer — seeded from + persisted to the server", () => {
  function stubOnboardingFetch(demoOffered: boolean, calls: Array<{ url: string; init?: RequestInit }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("/api/onboarding/state")) {
          return { ok: true, json: async () => ({ demoOffered }) };
        }
        return { ok: true, json: async () => [] }; // /api/agent/providers
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("seeds onboardingDemoOffer true from a fresh GET — the reload case", async () => {
    stubOnboardingFetch(true, []);
    const get = captureCtx();

    expect(get().onboardingDemoOffer).toBe(false); // nothing seeded yet on first render
    await vi.waitFor(() => expect(get().onboardingDemoOffer).toBe(true));
  });

  it("stays false when the server says the offer was never armed or already resolved", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubOnboardingFetch(false, calls);
    const get = captureCtx();

    await vi.waitFor(() => expect(get().agentProvidersLoaded).toBe(true));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/api/onboarding/state"))).toBe(true));
    expect(get().onboardingDemoOffer).toBe(false);
  });

  it("persists a dismissal (PUT dismissDemoOffer:true) when the offer is cleared", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubOnboardingFetch(false, calls);
    const get = captureCtx();

    act(() => get().setOnboardingDemoOffer(true));
    expect(get().onboardingDemoOffer).toBe(true);

    act(() => get().setOnboardingDemoOffer(false));
    expect(get().onboardingDemoOffer).toBe(false); // chip's own behaviour: clears immediately

    await vi.waitFor(() => {
      const put = calls.find(
        (c) => c.url.includes("/api/onboarding/state") && c.init?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.init!.body as string)).toEqual({ dismissDemoOffer: true });
    });
  });

  it("does not fire a dismiss request when the offer is armed true", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubOnboardingFetch(false, calls);
    const get = captureCtx();

    act(() => get().setOnboardingDemoOffer(true));
    await vi.waitFor(() => expect(get().agentProvidersLoaded).toBe(true));

    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });
});

/**
 * QA regression: the chat panel's Codex sign-in card ("Codex isn't signed
 * in on this machine…") rendered directly beneath a green "You're all set!"
 * demo-offer banner. Root cause was app/(app)/editor/page.tsx arming
 * `onboardingDemoOffer` off `activeProviderId` — which flips the moment an
 * agent is SELECTED, before the ACP handshake that would prove it can
 * actually be chatted with resolves (or fails). That arming call is now
 * gone; the offer is armed exclusively server-side, on an OBSERVED clean
 * connection (session-manager.ts#markAgentConnected /
 * #markAgentReady — both fire off the same successful `session/new`), and
 * the client re-reads it the moment `sessionList.readiness` reaches "ready"
 * (see the effect this describe block exercises, in
 * lib/editor-state-context.tsx).
 */
describe("onboarding demo offer — armed by an observed connection, not by agent selection", () => {
  function stubOnboardingFetch(getDemoOffered: () => boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/onboarding/state")) {
          return { ok: true, json: async () => ({ demoOffered: getDemoOffered() }) };
        }
        return { ok: true, json: async () => [] }; // /api/agent/providers
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("does not offer the demo tour when the agent was only selected, not connected", async () => {
    // The server never arms the offer in this scenario — no clean
    // session/new has ever happened — so GET /api/onboarding/state always
    // answers demoOffered:false, exactly like the QA repro's DB snapshot
    // (agent_ever_connected = 0, onboarding_demo_offered_at = NULL).
    stubOnboardingFetch(() => false);
    const { result, rerender } = renderHook(() => useEditorState(), {
      wrapper: EditorStateProvider,
    });

    await vi.waitFor(() => expect(result.current.agentProvidersLoaded).toBe(true));
    expect(result.current.onboardingDemoOffer).toBe(false);

    // An agent gets selected, and the handshake comes back as an observed
    // auth rejection (the QA repro's "Codex isn't signed in" card) — the
    // exact opposite of the "ready" signal the fix requires. If anything
    // still keyed off selection alone, this is where it would leak through.
    sessionListMock.current = {
      ...sessionListMock.current,
      activeAgentId: "codex",
      readiness: {
        state: "needs-auth",
        agentId: "codex",
        message: "Codex isn't signed in on this machine",
      },
    };
    rerender();

    // Let any effect scheduled by the re-render flush, then assert nothing
    // armed the offer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.onboardingDemoOffer).toBe(false);
  });

  it("offers the demo tour once a connection has actually succeeded", async () => {
    // Fresh install: not armed yet when the provider first mounts.
    let demoOffered = false;
    stubOnboardingFetch(() => demoOffered);
    const { result, rerender } = renderHook(() => useEditorState(), {
      wrapper: EditorStateProvider,
    });

    await vi.waitFor(() => expect(result.current.agentProvidersLoaded).toBe(true));
    expect(result.current.onboardingDemoOffer).toBe(false);

    // The connection now genuinely succeeds: session-manager arms the offer
    // server-side, and the client learns of the clean `session/new` via the
    // `agent-readiness` SSE broadcast reaching useSessionList — mirrored
    // here by flipping the mocked hook's readiness straight to "ready".
    // This is the gap removing the page.tsx arming call opened: without a
    // reload, the client must notice on its own.
    demoOffered = true;
    sessionListMock.current = {
      ...sessionListMock.current,
      activeAgentId: "codex",
      readiness: { state: "ready" },
    };
    rerender();

    await vi.waitFor(() => expect(result.current.onboardingDemoOffer).toBe(true));
  });
});

/**
 * `libi.show_extension` / `libi.start_onboarding` → `navigate_agents` → the
 * Agents page on the tab the event names — for libi MCP, scrolled to a card.
 *
 * The tab is the whole point: `Tabs.Panel` defaults to keepMounted:false and
 * Agents is the DEFAULT tab, so on `/agents` with any other tab showing there
 * is no McpServersView mounted, no listener for the CustomEvent, and no card
 * in the DOM. Matching on the pathname alone (what this once did) left the
 * agent saying "I've opened the card for you" while nothing moved. The pushed
 * URL carries the id as `&extension=` so the page itself can name the card.
 */
describe("navigate_agents — the named tab, not just the page", () => {
  function goto(url: string) {
    window.history.replaceState({}, "", url);
  }

  it("pushes ?tab=libi-mcp&extension= when the Skills tab is showing on the same page", () => {
    goto("/agents?tab=skills");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "libi-mcp", extensionId: "local-music" }));
    expect(routerMock.push).toHaveBeenCalledWith("/agents?tab=libi-mcp&extension=local-music");
  });

  it("pushes ?tab=libi-mcp when the URL carries no tab at all (the default is Agents)", () => {
    goto("/agents");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "libi-mcp" }));
    expect(routerMock.push).toHaveBeenCalledWith("/agents?tab=libi-mcp");
  });

  it("pushes from another page", () => {
    goto("/editor");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "libi-mcp", extensionId: "whisper" }));
    expect(routerMock.push).toHaveBeenCalledWith("/agents?tab=libi-mcp&extension=whisper");
  });

  it("does not push when the same extension on the libi MCP tab is already showing", () => {
    goto("/agents?tab=libi-mcp&extension=whisper");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "libi-mcp", extensionId: "whisper" }));
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("parks the id for a view that has not mounted yet, and still fires the event", () => {
    goto("/agents?tab=skills");
    captureCtx();
    const seen: Array<string | undefined> = [];
    const listener = (e: Event) =>
      seen.push(((e as CustomEvent).detail as { mcpId?: string }).mcpId);
    window.addEventListener(MCP_SCROLL_EVENT, listener);
    try {
      act(() => broadcast.emit({ type: "navigate_agents", tab: "libi-mcp", extensionId: "local-tts" }));
    } finally {
      window.removeEventListener(MCP_SCROLL_EVENT, listener);
    }
    expect(seen).toEqual(["local-tts"]);
    // The event above reaches nobody in the real app (the panel is unmounted);
    // this is what McpServersView claims when it finally mounts.
    expect(takePendingMcpScroll()).toBe("local-tts");
  });

  it("pushes the Agents tab for { tab: 'agents' } (libi.start_onboarding)", () => {
    goto("/editor");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "agents" }));
    expect(routerMock.push).toHaveBeenCalledWith("/agents?tab=agents");
  });

  it("pushes a different provider even when the Providers tab is already showing", () => {
    goto("/agents?tab=providers&provider=elevenlabs");
    captureCtx();
    act(() => broadcast.emit({ type: "navigate_agents", tab: "providers", provider: "fal" }));
    expect(routerMock.push).toHaveBeenCalledWith("/agents?tab=providers&provider=fal");
  });
});
