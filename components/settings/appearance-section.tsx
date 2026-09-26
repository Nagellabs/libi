"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Settings → General → "Appearance" (light / dark).
 *
 * The `dark` class on <html> is the single source of truth: the inline script
 * in app/layout.tsx applies the stored preference (`localStorage.theme`)
 * before hydration, and choosing a mode below flips the class directly and
 * writes the same key. Reading it through useSyncExternalStore (server
 * snapshot: dark) avoids both the hydration mismatch and the mount-effect
 * setState the hooks lint rejects — and follows a change made anywhere else
 * (the terminal view observes the same class).
 *
 * Only Light and Dark exist: the pre-hydration script treats anything but
 * "light" as dark, so there is no "System" mode to offer.
 */
function subscribeToThemeClass(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
const isDarkSnapshot = () => document.documentElement.classList.contains("dark");
const serverSnapshot = () => true;

type ThemeMode = "light" | "dark";

const MODES: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

function applyThemeMode(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", mode === "dark");
  try {
    localStorage.setItem("theme", mode);
  } catch {
    // Storage blocked: the class still switches for this session.
  }
}

export function AppearanceSection() {
  const dark = useSyncExternalStore(subscribeToThemeClass, isDarkSnapshot, serverSnapshot);
  const current: ThemeMode = dark ? "dark" : "light";

  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">Appearance</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The color theme for the whole app. Saved on this device.
      </p>

      <div
        role="group"
        aria-label="Color theme"
        className="mt-3 inline-flex gap-1 rounded-md border border-border p-1"
      >
        {MODES.map(({ id, label, Icon }) => {
          const active = current === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              data-testid={`theme-mode-${id}`}
              onClick={() => applyThemeMode(id)}
              className={`flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
