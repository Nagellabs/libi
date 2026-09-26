// @vitest-environment jsdom
//
// Final review F13: the Templates page upgrade's features emit adoption
// events — closed enums only, never an id or a name.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/client", () => ({ trackEvent }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(""),
}));

import { DetailsPlayer, useDetailsViewed } from "@/components/templates/template-details/details-layout";
import { useExampleInlinePlay } from "@/components/templates/templates-page/use-example-inline-play";
import { useTemplatesPageParams } from "@/components/templates/templates-page/use-templates-page-params";
import { EVENT_NAMES } from "@/lib/analytics/events";

beforeEach(() => {
  trackEvent.mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Templates adoption events", () => {
  it("every new name is in the taxonomy", () => {
    for (const n of ["template_preview_requested", "template_preview_rendered", "template_details_viewed", "template_example_played", "templates_view_switched"]) {
      expect(EVENT_NAMES).toContain(n);
    }
  });

  it("the Cards / List switch: templates_view_switched { view }", () => {
    const { result } = renderHook(() => useTemplatesPageParams());
    act(() => result.current.setView("list"));
    expect(trackEvent).toHaveBeenCalledWith("templates_view_switched", { view: "list" });
  });

  it("a card's play with sound: template_example_played { where: card }", () => {
    const { result } = renderHook(() => useExampleInlinePlay("/api/templates/t1/media/example.mp4?v=1-0"));
    act(() => result.current.start());
    expect(trackEvent).toHaveBeenCalledWith("template_example_played", { where: "card" });
  });

  it("the page's player: template_example_played { where: details } once, however often it plays", () => {
    render(<DetailsPlayer exampleUrl="/x.mp4" posterUrl={null} canvas={{ width: 16, height: 9 }} />);
    const v = screen.getByTestId("template-details-video");
    fireEvent.play(v);
    fireEvent.play(v);
    expect(trackEvent.mock.calls.filter(([n]) => n === "template_example_played")).toEqual([["template_example_played", { where: "details" }]]);
  });

  it("a template's page: template_details_viewed { scope } once it has loaded, once", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { rerender } = renderHook(({ loaded }) => useDetailsViewed("public", loaded), { initialProps: { loaded: false }, wrapper });
    expect(trackEvent).not.toHaveBeenCalled();
    rerender({ loaded: true });
    rerender({ loaded: true });
    expect(trackEvent.mock.calls).toEqual([["template_details_viewed", { scope: "public" }]]);
  });
});
