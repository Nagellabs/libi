// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  EditorStateProvider,
  useEditorState,
} from "@/lib/editor-state-context";

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: () => () => {},
}));

beforeEach(() => {
  localStorage.clear();
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

describe("editor-state-context script additions", () => {
  it("accepts and persists 'script' as a lastAssetTab value", () => {
    const get = captureCtx();
    act(() => get().setLastAssetTab("script"));
    expect(get().lastAssetTab).toBe("script");
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.lastAssetTab).toBe("script");
  });

  it("defaults scriptShotRailPct to 35", () => {
    const get = captureCtx();
    expect(get().scriptShotRailPct).toBe(35);
  });

  it("persists scriptShotRailPct changes", () => {
    const get = captureCtx();
    act(() => get().setScriptShotRailPct(50));
    expect(get().scriptShotRailPct).toBe(50);
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.scriptShotRailPct).toBe(50);
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

describe("timeline zoom state", () => {
  it("defaults previewTimelineZoom to null", () => {
    const get = captureCtx();
    expect(get().previewTimelineZoom).toBeNull();
  });

  it("persists previewTimelineZoom changes (number)", () => {
    const get = captureCtx();
    act(() => get().setPreviewTimelineZoom(200));
    expect(get().previewTimelineZoom).toBe(200);
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.previewTimelineZoom).toBe(200);
  });

  it("loads a stored positive previewTimelineZoom", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ previewTimelineZoom: 350 }),
    );
    const get = captureCtx();
    expect(get().previewTimelineZoom).toBe(350);
  });

  it("falls back to null on a malformed previewTimelineZoom", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ previewTimelineZoom: "nope" }),
    );
    const get = captureCtx();
    expect(get().previewTimelineZoom).toBeNull();
  });

  it("falls back to null on a non-positive previewTimelineZoom", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({ previewTimelineZoom: 0 }),
    );
    const get = captureCtx();
    expect(get().previewTimelineZoom).toBeNull();
  });

  it("setPreviewTimelineZoom(null) clears the stored value back to null", () => {
    const get = captureCtx();
    act(() => get().setPreviewTimelineZoom(200));
    act(() => get().setPreviewTimelineZoom(null));
    expect(get().previewTimelineZoom).toBeNull();
    const raw = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(raw.previewTimelineZoom).toBeNull();
  });
});

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
        remedy: null,
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
