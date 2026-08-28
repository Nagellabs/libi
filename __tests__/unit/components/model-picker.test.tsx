// @vitest-environment jsdom
/**
 * The picker races session activation: a restored session registers with
 * configOptions: [] and the GET answers {supported:false, pending:true}
 * seconds before the replay fills them. The old guard rendered null on the
 * collapsed {supported:false} and nothing ever invalidated it — every
 * restored session lost its picker until reload. Now: pending → skeleton
 * pill (repo convention: skeletons mirror the real layout, never spinners);
 * the agent-config-options SSE event patches the cache via
 * sessionModelEmitter and the real pill mounts; only a genuine
 * "no model select" hides it.
 *
 * Two layers are covered here on purpose. The `sessionModelEmitter` tests
 * pin the query hook's cache-patch contract; the "over the SSE singleton"
 * tests drive a real (fake) EventSource frame through `useAgentChat`'s
 * routing block, because an emitter nobody feeds would pass the first set
 * while the bug stayed exactly as it is in production.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import ModelPicker from "@/components/chat/model-picker";
import {
  sessionModelEmitter,
  useAgentChat,
} from "@/hooks/sessions/use-agent-chat";

const SUPPORTED = {
  supported: true as const,
  currentModelId: "default",
  availableModels: [
    {
      id: "default",
      name: "Default (recommended)",
      description: "Opus 5 · Best for everyday tasks",
    },
  ],
};

let fetchResponse: unknown;

/** Minimal stand-in for the browser EventSource so a test can hand the SSE
 *  singleton an exact frame. Mirrors the shape used by the stream tests. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function sse(frame: Record<string, unknown>) {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!es) throw new Error("no EventSource created");
  act(() => {
    es.onmessage?.({ data: JSON.stringify(frame) });
  });
}

/** Resolves once the test releases it; `null` means "answer immediately". Lets
 *  a test hold the model GET open and land its response AFTER an SSE event. */
let gateModelGet: Promise<void> | null = null;

beforeEach(() => {
  // This suite has no global clearMocks, and a stubbed implementation
  // outlives vi.clearAllMocks() — re-stub from scratch every test so no
  // response body leaks into the next one.
  fetchResponse = { supported: false, pending: true };
  gateModelGet = null;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!String(url).endsWith("/model")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (gateModelGet) await gateModelGet;
      return { ok: true, json: async () => fetchResponse };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // focusManager is a module singleton — a test that focuses it would
  // otherwise change how every later test's queries revalidate.
  focusManager.setFocused(undefined);
});

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(ui: ReactElement, qc: QueryClient = newClient()) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** How many times the model GET has been issued. */
function modelFetchCount() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith("/model")).length;
}

/** Mounts the picker alongside a live useAgentChat so the SSE singleton is
 *  open and its routing block is the thing under test. */
function ChatHost({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  useAgentChat(sessionId);
  return <>{children}</>;
}

function skeleton() {
  return document.querySelector("[data-slot='skeleton']");
}

/** React Query notifies its observers through notifyManager, which schedules
 *  on a TIMER — a synchronous `act()` around an emit returns before the
 *  re-render it causes, and even a microtask flush is too early. Assertions
 *  that something did NOT change need this; without it they passed against a
 *  deliberately unguarded cache write. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("ModelPicker pending/unsupported states", () => {
  it("renders a skeleton pill while the model state is pending, not nothing", async () => {
    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(skeleton()).toBeInTheDocument());
    expect(screen.queryByRole("button")).toBeNull();
    // The skeleton stands in for the trigger, so it must carry the trigger's
    // own height and radius — otherwise the real pill arrives with a visible
    // jump. Width is deliberately NOT pinned: the pill is content-sized and
    // w-24 is just a plausible reservation.
    expect(skeleton()).toHaveClass("h-8", "rounded-lg");
  });

  it("sizes the skeleton from the same classes the real trigger uses", async () => {
    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(skeleton()).toBeInTheDocument());
    const skeletonClasses = skeleton()!.className.split(/\s+/);

    act(() => {
      sessionModelEmitter.emit({ sessionId: "s1", model: SUPPORTED });
    });
    const trigger = await screen.findByLabelText("Model: Opus 5");

    // Whichever height/radius the trigger moves to, the skeleton follows.
    const triggerClasses = trigger.className.split(/\s+/);
    for (const c of triggerClasses.filter(
      (t) => t.startsWith("h-") || t.startsWith("rounded-"),
    )) {
      expect(skeletonClasses).toContain(c);
    }
  });

  it("swaps the skeleton for the real pill when agent-config-options arrives", async () => {
    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(skeleton()).toBeInTheDocument());
    act(() => {
      sessionModelEmitter.emit({ sessionId: "s1", model: SUPPORTED });
    });
    // Trigger label is the versioned name extracted from the description.
    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );
    expect(skeleton()).toBeNull();
  });

  it("ignores events for other sessions", async () => {
    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(skeleton()).toBeInTheDocument());
    act(() => {
      sessionModelEmitter.emit({ sessionId: "someone-else", model: SUPPORTED });
    });
    await settle();
    expect(screen.queryByLabelText("Model: Opus 5")).toBeNull();
    expect(skeleton()).toBeInTheDocument();
  });

  it("hides entirely on a genuine unsupported answer", async () => {
    fetchResponse = { supported: false, pending: false };
    const { container } = wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(skeleton()).toBeNull());
    expect(container.firstChild).toBeNull();
  });
});

describe("ModelPicker over the SSE singleton", () => {
  it("resolves the skeleton from a real agent-config-options frame", async () => {
    wrap(
      <ChatHost sessionId="s1">
        <ModelPicker sessionId="s1" />
      </ChatHost>,
    );
    await waitFor(() => expect(skeleton()).toBeInTheDocument());

    sse({ type: "agent-config-options", sessionId: "s1", model: SUPPORTED });

    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );
  });

  /**
   * When activation FAILS the server still publishes a terminal
   * agent-config-options (`SessionManager#emitTerminalModelSnapshot`) — every
   * failure exit does, including the ones that throw before any status frame
   * exists. That frame, and only that frame, ends the skeleton.
   */
  it("stops pulsing on the terminal frame a failed activation publishes", async () => {
    wrap(
      <ChatHost sessionId="s1">
        <ModelPicker sessionId="s1" />
      </ChatHost>,
    );
    await waitFor(() => expect(skeleton()).toBeInTheDocument());

    sse({
      type: "agent-config-options",
      sessionId: "s1",
      model: { supported: false, pending: false },
    });

    await waitFor(() => expect(skeleton()).toBeNull());
    expect(screen.queryByLabelText("Model: Opus 5")).toBeNull();
  });

  /**
   * `agent-status: error` must stay inert here. It fires for things that say
   * nothing about the model select — `sendMessage` on an inactive session, a
   * process crash mid-turn — and an earlier revision that resolved the model
   * state from it took a working pill away and put it back a moment later.
   */
  it("ignores agent-status: error entirely", async () => {
    wrap(
      <ChatHost sessionId="s1">
        <ModelPicker sessionId="s1" />
      </ChatHost>,
    );
    await waitFor(() => expect(skeleton()).toBeInTheDocument());

    sse({
      type: "agent-status",
      sessionId: "s1",
      status: "error",
      error: "prompt failed",
    });
    await settle();
    expect(skeleton()).toBeInTheDocument();

    sse({ type: "agent-config-options", sessionId: "s1", model: SUPPORTED });
    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );

    sse({
      type: "agent-status",
      sessionId: "s1",
      status: "error",
      error: "process crashed",
    });
    await settle();

    expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument();
    expect(skeleton()).toBeNull();
  });
});

/**
 * The cache-write rules that keep the skeleton from getting stuck. Each test
 * here pins one line of `useSessionModel`; without them the query options
 * could be deleted wholesale and the suite would stay green.
 */
describe("ModelPicker cache/refetch contract", () => {
  it("keeps the SSE snapshot when the racing GET resolves afterwards", async () => {
    // Switching sessions mid-activation is enough to produce this: the
    // remount's `refetchOnMount: "always"` GET is still in flight when
    // activation completes and emits. The GET's body is the PRE-activation
    // answer, so letting it win puts the skeleton back — permanently, since
    // `staleTime: Infinity` means nothing ever refetches or re-emits.
    let releaseGet = () => {};
    gateModelGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(modelFetchCount()).toBe(1));
    expect(skeleton()).toBeInTheDocument();

    act(() => {
      sessionModelEmitter.emit({ sessionId: "s1", model: SUPPORTED });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );

    act(() => releaseGet());
    await settle();

    expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument();
    expect(skeleton()).toBeNull();
  });

  it("refetches on remount even though the cached entry is fresh", async () => {
    // `refetchOnMount: "always"`. The SSE listener seeds cache entries for
    // ANY session that emits, and under `staleTime: Infinity` such a seed
    // reads as permanently fresh — so a plain `refetchOnMount: true` would
    // let it suppress the authoritative snapshot for the whole mount.
    const qc = newClient();
    const first = wrap(<ModelPicker sessionId="s1" />, qc);
    await waitFor(() => expect(modelFetchCount()).toBe(1));

    act(() => {
      sessionModelEmitter.emit({ sessionId: "s1", model: SUPPORTED });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );

    first.unmount();
    wrap(<ModelPicker sessionId="s1" />, qc);

    await waitFor(() => expect(modelFetchCount()).toBe(2));
  });

  it("does not revalidate a live query on window focus", async () => {
    // `staleTime: Infinity`. SSE is what keeps this query fresh, so the GET
    // runs once per mount and never again. Drop the staleTime and every
    // window focus refetches — landing the server's pre-activation
    // `pending: true` on top of a resolved pill and restoring the skeleton.
    wrap(<ModelPicker sessionId="s1" />);
    await waitFor(() => expect(modelFetchCount()).toBe(1));

    act(() => {
      sessionModelEmitter.emit({ sessionId: "s1", model: SUPPORTED });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument(),
    );

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();

    expect(modelFetchCount()).toBe(1);
    expect(screen.getByLabelText("Model: Opus 5")).toBeInTheDocument();
    expect(skeleton()).toBeNull();
  });
});
