"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

// The `dark` class on <html> is the single source of truth: the inline script
// in app/layout.tsx applies the stored preference before hydration, and the
// toggle below flips the class directly. Reading it through
// useSyncExternalStore (server snapshot: dark) avoids both the hydration
// mismatch and the mount-effect setState the hooks lint rejects.
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

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribeToThemeClass, isDarkSnapshot, serverSnapshot);

  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const label = dark ? "Light mode" : "Dark mode";

  // Renders a bare <SidebarMenuItem> so the caller can place it inside the
  // SAME <SidebarMenu> as the other footer items — that's what keeps the
  // footer rows evenly spaced (one gap-0 menu, not several stacked ones).
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={toggle}
        tooltip={label}
        className="cursor-pointer"
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
