"use client";

import { useEffect } from "react";
import { installMediaConsoleNoiseFilter } from "@/lib/engine/media-console-noise";

/**
 * Installs the mediabunny console-noise filter (see
 * `lib/engine/media-console-noise.ts` for what it covers and why).
 *
 * DEV ONLY, and only because of the dev overlay: in production a stray
 * `console.error` is just a console line, so there is nothing to fix and no
 * reason to patch a global. Renders nothing.
 */
export function MediaConsoleNoiseFilter() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    return installMediaConsoleNoiseFilter();
  }, []);

  return null;
}
