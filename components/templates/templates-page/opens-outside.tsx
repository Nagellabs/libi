import { ExternalLink } from "lucide-react";

/** What a screen reader hears after a link that leaves libi. */
export const OPENS_OUTSIDE_TEXT = "(opens in your browser)";

/**
 * Put inside an `<a target="_blank">` that leaves libi — the desktop app hands
 * such a link to the system browser, and under npx it opens a new tab. Shows
 * the app's usual ExternalLink icon (as on the Docs and npm links) and gives
 * a screen reader the same warning in words, so the link's name says it.
 */
export function OpensOutside() {
  return (
    <>
      {/* A real space, outside the icon and the hidden words: it separates them from the link text for a screen reader too. */}{" "}
      <ExternalLink aria-hidden="true" data-testid="opens-outside-icon" className="inline size-3 shrink-0 align-[-0.125em]" />
      <span className="sr-only">{OPENS_OUTSIDE_TEXT}</span>
    </>
  );
}
