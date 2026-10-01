"use client";

export const COPYRIGHT_BADGE_TITLE = "Copyrighted — left out of social exports by default";

/** The timeline's © mark on a copyrighted clip. Generated/owned music gets none. */
export function CopyrightBadge() {
  return (
    <span data-testid="copyright-badge" title={COPYRIGHT_BADGE_TITLE} className="relative z-10 shrink-0 cursor-help text-[10px] font-semibold text-amber-400">
      ©
    </span>
  );
}
