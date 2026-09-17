"use client";

import { LoaderCircle } from "lucide-react";

/**
 * A button's label while the work it stands for is still running: a spinner and
 * what is happening. A disabled button that only reads "Next" says nothing about
 * why it can't be pressed yet, so the wait is named on the button itself.
 */
export function BusyLabel({ children }: { children: string }) {
  return (
    <>
      <LoaderCircle aria-hidden data-icon="inline-start" className="motion-safe:animate-spin" />
      {children}
    </>
  );
}

/**
 * For a button that goes busy: pass `focusableWhenDisabled` while it is, so it is
 * aria-disabled rather than natively disabled and keeps keyboard focus. This keeps
 * it readable (the default disabled fade makes it look broken rather than working)
 * and inert to the pointer while aria-disabled.
 */
export const BUSY_BUTTON_CLASS = "aria-disabled:pointer-events-none aria-disabled:opacity-80";
