// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AppearanceSection } from "@/components/settings/appearance-section";

/**
 * AppearanceSection reads the `dark` class on <html> through
 * useSyncExternalStore (a MutationObserver-backed subscription) — the class is
 * the single source of truth, seeded pre-hydration by the inline script in
 * app/layout.tsx from `localStorage.theme`.
 */
const pressed = (id: "light" | "dark") =>
  screen.getByTestId(`theme-mode-${id}`).getAttribute("aria-pressed");

describe("AppearanceSection", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.add("dark");
  });

  it("offers exactly Light and Dark, with the current mode pressed", () => {
    render(<AppearanceSection />);
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(pressed("dark")).toBe("true");
    expect(pressed("light")).toBe("false");
    expect(screen.queryByText(/system/i)).toBeNull();
  });

  it("switching to Light flips the class, persists the choice, and moves the selection", async () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByTestId("theme-mode-light"));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
    // The MutationObserver notification is async — the selection follows.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pressed("light")).toBe("true");
    expect(pressed("dark")).toBe("false");
  });

  it("switching back to Dark restores the class and storage", async () => {
    document.documentElement.classList.remove("dark");
    render(<AppearanceSection />);
    expect(pressed("light")).toBe("true");

    fireEvent.click(screen.getByTestId("theme-mode-dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    await act(async () => {
      await Promise.resolve();
    });
    expect(pressed("dark")).toBe("true");
  });

  it("follows an EXTERNAL class change (another surface changed the theme)", async () => {
    render(<AppearanceSection />);
    expect(pressed("dark")).toBe("true");

    await act(async () => {
      document.documentElement.classList.remove("dark");
      await Promise.resolve();
    });
    expect(pressed("light")).toBe("true");
  });

  it("every option is a pointer-cursor button", () => {
    render(<AppearanceSection />);
    for (const id of ["light", "dark"] as const) {
      const el = screen.getByTestId(`theme-mode-${id}`);
      expect(el.tagName).toBe("BUTTON");
      expect(el.className).toContain("cursor-pointer");
    }
  });
});
