"use client";

import { useEffect } from "react";
import { ensureBundledFontsLoaded } from "@/lib/fonts/load-client";

/**
 * Downloads libi's bundled text faces as soon as the app mounts.
 *
 * The `@font-face` rules in `app/globals.css` DECLARE the faces but do not
 * fetch them — that only happens when rendered DOM needs one, and the preview
 * canvas is not DOM. Without this, the first draw of a text overlay measures
 * and paints in a fallback face; see `lib/fonts/load-client.ts` for the
 * measurements. Renders nothing.
 */
export function BundledFonts() {
  useEffect(() => {
    void ensureBundledFontsLoaded();
  }, []);

  return null;
}
