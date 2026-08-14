"use client";

import * as React from "react";
import { useState } from "react";
import { TopBar, useIsElectron } from "@/components/layout/top-bar";
import { AnnouncementBanner } from "@/components/layout/announcement-banner";

/**
 * Outer chrome for every (app) page: the full-height flex column that owns
 * the optional titlebar and announcement banner, and the `--topbar-h` /
 * `--banner-h` reservations read by the fixed sidebar
 * (`components/ui/sidebar.tsx`).
 *
 * - Electron: render <TopBar /> (drag region + Win/Linux controls) and
 *   reserve 36px via `--topbar-h` so the sidebar/panels sit below it.
 * - Web:      no titlebar, `--topbar-h: 0px` — the strip would just be dead
 *   space in a regular browser tab, so it's removed entirely.
 * - `--banner-h` mirrors the announcement banner's live rendered height (0
 *   when there is none). The banner itself sits in normal flow between the
 *   titlebar and `{children}`, so it doesn't need this var — but the sidebar
 *   is `position: fixed` and has no other way to know the banner pushed the
 *   content down, so it reads `--banner-h` the same way it reads
 *   `--topbar-h` to avoid painting over the banner.
 *
 * Client-only because the Electron-vs-web decision can't be made on the
 * server. It starts in the web layout (no bar) to keep SSR + hydration in
 * sync, then reveals the bar in Electron on mount.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const isElectron = useIsElectron();
  const [bannerHeight, setBannerHeight] = useState(0);

  return (
    <div
      className="flex h-svh w-full flex-col overflow-hidden"
      style={
        {
          // Single source of truth for the titlebar height. 0 in the
          // browser (no bar), 36px in Electron.
          "--topbar-h": isElectron ? "36px" : "0px",
          // Live announcement banner height, reserved for the fixed sidebar.
          "--banner-h": `${bannerHeight}px`,
        } as React.CSSProperties
      }
    >
      {isElectron && <TopBar />}
      <AnnouncementBanner onHeightChange={setBannerHeight} />
      {children}
    </div>
  );
}
