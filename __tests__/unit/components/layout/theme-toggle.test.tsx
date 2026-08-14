// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The sidebar chrome is shadcn/base-ui plumbing (cookies, matchMedia, context)
// that has nothing to do with the theme behavior under test.
vi.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    SidebarMenuItem: Pass,
    SidebarMenuButton: ({
      children,
      onClick,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

import { ThemeToggle } from "@/components/layout/theme-toggle";

/**
 * ThemeToggle reads the `dark` class on <html> through useSyncExternalStore
 * (a MutationObserver-backed subscription) — the class is the single source
 * of truth, seeded pre-hydration by the inline script in app/layout.tsx.
 */
function renderToggle() {
  return render(<ThemeToggle />);
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.add("dark");
  });

  it("shows 'Light mode' while dark and flips class + storage on click", async () => {
    renderToggle();
    expect(screen.getByText("Light mode")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Light mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
    // The MutationObserver notification is async — the label follows.
    expect(await screen.findByText("Dark mode")).toBeInTheDocument();
  });

  it("toggles back to dark", async () => {
    document.documentElement.classList.remove("dark");
    renderToggle();
    expect(await screen.findByText("Dark mode")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dark mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(await screen.findByText("Light mode")).toBeInTheDocument();
  });

  it("follows an EXTERNAL class change (another surface toggled the theme)", async () => {
    renderToggle();
    expect(screen.getByText("Light mode")).toBeInTheDocument();

    await act(async () => {
      document.documentElement.classList.remove("dark");
      // Let the MutationObserver microtask deliver.
      await Promise.resolve();
    });
    expect(await screen.findByText("Dark mode")).toBeInTheDocument();
  });
});
