// @vitest-environment jsdom
// Settings → Templates exists only in a dev build (review M5): a packaged or
// npm build opened at `?tab=templates` shows General, never the panel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ data: undefined as unknown, isError: false }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams("tab=templates"),
}));
vi.mock("@/lib/queries/templates-catalog", () => ({ useTemplatesCatalog: () => ({ data: state.data, isError: state.isError }) }));
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
vi.mock("@/components/settings/templates-catalog-card", () => ({ TemplatesCatalogCard: () => <div data-testid="templates-catalog-card" /> }));
import SettingsPage from "@/app/(app)/settings/page";

const active = { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" };
afterEach(() => {
  cleanup();
  state.data = undefined;
  state.isError = false;
});

describe("Settings ?tab=templates", () => {
  it("a packaged build shows General — no Templates tab, no Templates panel", () => {
    state.data = { devBuild: false, testMode: false, active, legalOrigin: active.origin };
    render(<SettingsPage />);
    expect(screen.queryByTestId("settings-tab-templates")).toBeNull();
    expect(screen.queryByTestId("templates-catalog-card")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Templates" })).toBeNull();
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
  });
  it("a view that can't be read is treated the same", () => {
    state.isError = true;
    render(<SettingsPage />);
    expect(screen.queryByTestId("templates-catalog-card")).toBeNull();
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
  });
  it("a dev build shows the Templates tab and panel", () => {
    state.data = { devBuild: true, testMode: false, active, legalOrigin: active.origin };
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-templates")).toBeInTheDocument();
    expect(screen.getByTestId("templates-catalog-card")).toBeInTheDocument();
  });
});
