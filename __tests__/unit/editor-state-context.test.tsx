// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  EditorStateProvider,
  useEditorState,
} from "@/lib/editor-state-context";

vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: () => () => {},
}));

beforeEach(() => localStorage.clear());

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
