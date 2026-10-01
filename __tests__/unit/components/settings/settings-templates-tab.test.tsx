// @vitest-environment jsdom
// Settings → Templates exists only in a dev build (review M5): a packaged or
// npm build opened at `?tab=templates` shows General, never the panel. A view
// that failed to load, opened at `?tab=templates`, keeps the panel so the
// card's error and Retry can be reached (review N3).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ data: undefined as unknown, isError: false, search: "tab=templates", refetch: (() => undefined) as () => unknown }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("@/lib/queries/templates-catalog", () => ({
  useTemplatesCatalog: () => ({ data: state.data, isError: state.isError, refetch: state.refetch }),
  useSetTemplatesCatalog: () => ({ isPending: false, variables: undefined, mutate: vi.fn() }),
}));
// Everything else on the page is not under test here.
vi.mock("@/components/layout/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/ui/sidebar", () => ({ SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/banner/instructions-updated-banner", () => ({ InstructionsUpdatedBanner: () => null }));
vi.mock("@/components/settings/general-tab", () => ({ GeneralTab: () => <div data-testid="general-tab" /> }));
vi.mock("@/components/settings/db-backups-tab", () => ({ DbBackupsTab: () => null }));
vi.mock("@/components/settings/data-folder-tab", () => ({ DataFolderTab: () => null }));
vi.mock("@/components/settings/premium-tab", () => ({ PremiumTab: () => null }));
vi.mock("@/components/settings/jobs-tab", () => ({ JobsTab: () => null }));
vi.mock("@/components/settings/notifications-tab", () => ({ NotificationsTab: () => null }));
vi.mock("@/components/settings/export-tab", () => ({ ExportTab: () => null }));
vi.mock("@/components/settings/privacy-tab", () => ({ PrivacyTab: () => null }));
import SettingsPage from "@/app/(app)/settings/page";

const active = { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" };
/** The real card renders once the view is there: its heading-less body is the catalog switch. */
const devView = {
  devBuild: true,
  testMode: false,
  active,
  legalOrigin: active.origin,
  choice: "production",
  production: { origin: active.origin, host: active.host },
  development: { origin: null, isDefault: false, defaultOrigin: null },
  bypassToken: { set: false, applies: false },
};
afterEach(() => {
  cleanup();
  state.data = undefined;
  state.isError = false;
  state.search = "tab=templates";
  state.refetch = () => undefined;
});

describe("Settings ?tab=templates", () => {
  it("a packaged build shows General — no Templates tab, no Templates panel", () => {
    state.data = { devBuild: false, testMode: false, active, legalOrigin: active.origin };
    render(<SettingsPage />);
    expect(screen.queryByTestId("settings-tab-templates")).toBeNull();
    expect(screen.queryByTestId("templates-catalog-packaged")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Templates" })).toBeNull();
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
  });
  it("a view that can't be read, asked for by `?tab=templates`: the panel stays, with the card's error and a working Retry — but no tab", () => {
    state.isError = true;
    const refetch = vi.fn();
    state.refetch = refetch;
    render(<SettingsPage />);
    expect(screen.getByTestId("templates-catalog-error")).toHaveTextContent("Couldn’t load the catalog setting.");
    expect(screen.queryByTestId("general-tab")).toBeNull();
    expect(screen.queryByTestId("settings-tab-templates")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  it("a view that can't be read, without `?tab=templates`: General, as before", () => {
    state.isError = true;
    state.search = "";
    render(<SettingsPage />);
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("templates-catalog-error")).toBeNull();
  });
  it("a packaged build whose view LOADED still falls back to General at `?tab=templates` (review M5)", () => {
    state.data = { devBuild: false, testMode: false, active, legalOrigin: active.origin };
    state.isError = true;
    render(<SettingsPage />);
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("templates-catalog-error")).toBeNull();
    expect(screen.queryByTestId("templates-catalog-packaged")).toBeNull();
  });
  it("a dev build shows the Templates tab and panel", () => {
    state.data = devView;
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-templates")).toBeInTheDocument();
    expect(screen.queryByTestId("general-tab")).toBeNull();
    expect(screen.queryByTestId("templates-catalog-error")).toBeNull();
  });
});
