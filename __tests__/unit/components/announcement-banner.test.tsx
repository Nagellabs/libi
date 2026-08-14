// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnnouncementBanner } from "@/components/layout/announcement-banner";

vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));
import { trackEvent } from "@/lib/analytics/client";

// jsdom doesn't implement ResizeObserver. This is a minimal mock of a
// missing browser API (not an assertion-weakening shortcut): it invokes the
// callback once, synchronously, with the observed element so the banner's
// height-reporting effect has something to react to.
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element) {
    this.callback(
      [{ target: element } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

const FEATURE = {
  id: "a1",
  title: "Caption styles are here",
  body: "Ask your agent for animated captions.",
  kind: "feature",
  url: "https://libi.nagellabs.com/blog/captions",
  createdAt: "2026-08-12T00:00:00.000Z",
};

let getPayload: { announcement: unknown; liveIds: string[] };
let seenCalls: unknown[];

function mockFetch() {
  seenCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/api/announcements/seen")) {
      seenCalls.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    return Response.json(getPayload);
  });
}

function renderBanner(onHeightChange?: (height: number) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AnnouncementBanner onHeightChange={onHeightChange} />
    </QueryClientProvider>,
  );
}

describe("AnnouncementBanner", () => {
  beforeEach(() => {
    getPayload = { announcement: null, liveIds: [] };
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing when there is no announcement", async () => {
    const { container } = renderBanner();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the announcement, marks ALL live ids seen once, tracks kind", async () => {
    getPayload = { announcement: FEATURE, liveIds: ["a1", "a0"] };
    renderBanner();
    expect(await screen.findByText("Caption styles are here")).toBeInTheDocument();
    await waitFor(() => expect(seenCalls).toEqual([{ ids: ["a1", "a0"] }]));
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith("announcement_shown", { kind: "feature" });
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute(
      "href",
      FEATURE.url,
    );
  });

  it("caps the seen POST at 50 ids and keeps the latched announcement's id even when it falls outside the first 50", async () => {
    // liveIds is newest-first; the latched announcement (id-59) is the OLDEST /
    // last entry, well past position 50 — a plain slice(0, 50) would drop it, so
    // this pins the prepend-and-dedupe behavior rather than a case a bare slice
    // would also satisfy.
    const liveIds = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    getPayload = { announcement: { ...FEATURE, id: "id-59" }, liveIds };
    renderBanner();
    expect(await screen.findByText("Caption styles are here")).toBeInTheDocument();
    await waitFor(() => expect(seenCalls.length).toBe(1));
    const { ids } = seenCalls[0] as { ids: string[] };
    expect(ids).toHaveLength(50);
    expect(ids).toContain("id-59");
    expect(new Set(ids).size).toBe(50);
  });

  it("stays visible after the invalidated refetch returns null (latch)", async () => {
    getPayload = { announcement: FEATURE, liveIds: ["a1"] };
    renderBanner();
    await screen.findByText("Caption styles are here");
    await waitFor(() => expect(seenCalls.length).toBe(1));
    getPayload = { announcement: null, liveIds: [] };
    // The mutation's onSuccess invalidates the query; the banner must not vanish.
    await waitFor(() =>
      expect(screen.getByText("Caption styles are here")).toBeInTheDocument(),
    );
  });

  it("X dismisses immediately", async () => {
    getPayload = { announcement: FEATURE, liveIds: ["a1"] };
    renderBanner();
    await screen.findByText("Caption styles are here");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss announcement" }));
    expect(screen.queryByText("Caption styles are here")).not.toBeInTheDocument();
  });

  it("issue announcements get the destructive treatment", async () => {
    getPayload = {
      announcement: { ...FEATURE, id: "a2", kind: "issue", url: null },
      liveIds: ["a2"],
    };
    renderBanner();
    const banner = await screen.findByRole("status");
    expect(banner.className).toContain("destructive");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("reports its rendered height via onHeightChange while displayed", async () => {
    getPayload = { announcement: FEATURE, liveIds: ["a1"] };
    const onHeightChange = vi.fn();
    renderBanner(onHeightChange);
    await screen.findByText("Caption styles are here");
    await waitFor(() => expect(onHeightChange).toHaveBeenCalled());
    const [height] = onHeightChange.mock.calls[onHeightChange.mock.calls.length - 1];
    expect(typeof height).toBe("number");
    expect(height).toBeGreaterThanOrEqual(0);
  });

  it("reports height 0 after dismiss", async () => {
    getPayload = { announcement: FEATURE, liveIds: ["a1"] };
    const onHeightChange = vi.fn();
    renderBanner(onHeightChange);
    await screen.findByText("Caption styles are here");
    await waitFor(() => expect(onHeightChange).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss announcement" }));
    await waitFor(() =>
      expect(onHeightChange.mock.calls[onHeightChange.mock.calls.length - 1][0]).toBe(0),
    );
  });
});
