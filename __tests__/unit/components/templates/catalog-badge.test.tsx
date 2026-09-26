// @vitest-environment jsdom
// The Templates page's "Development catalog" badge: shown whenever a
// development catalog is active, never for production or test mode.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const state = vi.hoisted(() => ({ view: undefined as unknown }));
vi.mock("@/lib/queries/templates-catalog", () => ({ useTemplatesCatalog: () => ({ data: state.view }) }));
import { DevelopmentCatalogBadge } from "@/components/templates/templates-page/catalog-badge";

const active = (kind: "production" | "development" | "test-mode", origin: string | null) => ({ kind, origin, host: origin ? new URL(origin).host : null });
afterEach(() => {
  cleanup();
  state.view = undefined;
});

describe("DevelopmentCatalogBadge", () => {
  it("names the development catalog's host, and in a dev build links to the switch", () => {
    state.view = { devBuild: true, active: active("development", "http://localhost:3300") };
    render(<DevelopmentCatalogBadge />);
    const badge = screen.getByTestId("templates-dev-catalog-badge");
    expect(badge).toHaveTextContent("Development catalog · localhost:3300");
    expect(badge).toHaveAttribute("href", "/settings?tab=templates");
    expect(badge.className).toContain("cursor-pointer");
  });
  it("a build pointed at a staging site shows it too, without a link", () => {
    state.view = { devBuild: false, active: active("development", "https://staging.example.com") };
    render(<DevelopmentCatalogBadge />);
    expect(screen.getByTestId("templates-dev-catalog-badge").tagName).toBe("SPAN");
  });
  it("nothing for production, test mode, or before the view loads", () => {
    for (const view of [undefined, { devBuild: true, active: active("production", "https://libi.nagellabs.com") }, { devBuild: true, active: active("test-mode", null) }]) {
      state.view = view;
      const { unmount } = render(<DevelopmentCatalogBadge />);
      expect(screen.queryByTestId("templates-dev-catalog-badge")).toBeNull();
      unmount();
    }
  });
});
