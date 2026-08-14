"use client";

import * as React from "react";
import { Minus, Square, Maximize2, X } from "lucide-react";

/**
 * Full-width app titlebar. Renders on every (app) page and is the
 * single drag surface for the whole window — chat, editor, resources,
 * and the sidebar all live BELOW it and have no per-panel drag region.
 *
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │ [mac traffic lights]              … future content …  [- □ X] │  ← 36 px
 *  └───────────────────────────────────────────────────────────────┘
 *
 * - macOS:        empty 78 px reservation on the left for the OS
 *                  traffic lights drawn by `titleBarStyle: hiddenInset`.
 * - Windows/Linux: min / maximize / close buttons on the right,
 *                  vertically centered with breathing room.
 * - Web:          renders identical markup so layout is stable across
 *                  surfaces, but `WebkitAppRegion` is a CSS no-op so
 *                  the strip is just a thin spacer.
 *
 * The bar deliberately has NO brand: the sidebar's `SidebarHeader`
 * already shows the libi mark + label, so a second copy was visual
 * noise. The middle area is reserved for future use (status, search,
 * piece title, etc.).
 */

interface ElectronApi {
  platform?: string;
  windowMinimize?: () => Promise<void>;
  windowMaximize?: () => Promise<void>;
  windowClose?: () => Promise<void>;
  windowIsMaximized?: () => Promise<boolean>;
}

function bridge(): ElectronApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
}

type Platform = "darwin" | "win32" | "linux" | "web";

function detectPlatform(): Platform {
  const api = bridge();
  const p = api?.platform;
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  if (p === "linux") return "linux";
  return "web";
}

/**
 * True only when running inside the Electron shell. Starts `false` so the
 * SSR + first client render match the web case (no hydration mismatch);
 * flips to `true` in an effect when the Electron preload bridge is present.
 * The layout uses this to render the titlebar — and reserve its height —
 * ONLY in Electron, where the drag region and Win/Linux window controls are
 * actually needed. In a plain web browser the titlebar is pure dead space.
 */
export function useIsElectron(): boolean {
  const [isElectron, setIsElectron] = React.useState(false);
  React.useEffect(() => {
    setIsElectron(detectPlatform() !== "web");
  }, []);
  return isElectron;
}

export function TopBar() {
  const [platform, setPlatform] = React.useState<Platform>("web");
  const [isMax, setIsMax] = React.useState(false);

  React.useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  // Poll maximize state for the Win/Linux Restore/Maximize icon swap.
  React.useEffect(() => {
    if (platform !== "win32" && platform !== "linux") return;
    let cancelled = false;
    const tick = async () => {
      const v = await bridge()?.windowIsMaximized?.();
      if (!cancelled && typeof v === "boolean") setIsMax(v);
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [platform]);

  const showMacPad = platform === "darwin";
  const showWinControls = platform === "win32" || platform === "linux";

  return (
    <header
      data-topbar
      data-platform={platform}
      // The entire header is the drag region. Child buttons override
      // with `no-drag` so they remain clickable.
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      className="relative z-30 flex h-[var(--topbar-h,36px)] w-full shrink-0 select-none items-center border-b border-border bg-sidebar/95 text-sidebar-foreground"
    >
      {/* macOS traffic-light reservation. Sized to clear the lights at
          the default `trafficLightPosition`. */}
      {showMacPad && <div className="h-full w-[78px] shrink-0" aria-hidden />}

      {/* Spacer — empty for now, reserved for future content (status,
          piece name, etc.). The drag region is owned by the parent
          <header>; nothing extra needed. */}
      <div className="flex-1" />

      {/* Windows / Linux window controls. The wrapper centers the
          buttons vertically inside the 36 px bar via `items-center`
          (not `items-stretch`), and each button has its own intrinsic
          height of 24 px so there's a 6 px gap above and below — that's
          the "vertically centered" look. */}
      {showWinControls && (
        <div
          className="flex items-center gap-1 pr-2"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <WindowControl
            label="Minimize"
            onClick={() => bridge()?.windowMinimize?.()}
            className="hover:bg-sidebar-accent"
          >
            <Minus className="size-3.5" strokeWidth={1.8} />
          </WindowControl>
          <WindowControl
            label={isMax ? "Restore" : "Maximize"}
            onClick={() => bridge()?.windowMaximize?.()}
            className="hover:bg-sidebar-accent"
          >
            {isMax ? (
              <Square className="size-3" strokeWidth={1.8} />
            ) : (
              <Maximize2 className="size-3" strokeWidth={1.8} />
            )}
          </WindowControl>
          <WindowControl
            label="Close"
            onClick={() => bridge()?.windowClose?.()}
            className="hover:bg-red-600 hover:text-white"
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </WindowControl>
        </div>
      )}
    </header>
  );
}

function WindowControl({
  children,
  label,
  onClick,
  className,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      // 24 px tall × 32 px wide. Inside a 36 px bar with `items-center`,
      // that leaves a 6 px breathing-room above and below — the vertical-
      // center placement the user asked for.
      className={
        "grid h-6 w-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors " +
        (className ?? "")
      }
    >
      {children}
    </button>
  );
}
