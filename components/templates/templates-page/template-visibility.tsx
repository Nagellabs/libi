"use client";

import { useId, useState } from "react";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";
import { Button } from "@/components/ui/button";
import { useSetTemplateHidden } from "@/lib/queries/templates-cloud";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import { LEGAL_LINKS, type LegalLinks } from "@/lib/legal-links";
import { useLegalLinks } from "@/lib/queries/templates-catalog";
import { utcDateLabel } from "@/lib/templates/details";
import { MODERATED_MESSAGE, moderationHeadline } from "@/lib/templates/cloud/constants";

/**
 * Where one of the creator's published templates stands, from its `/mine` entry:
 *  - `moderated`        hidden by moderation (reports or a takedown) — the owner can't show it again;
 *  - `hidden-settling`  hidden, but its catalog entry (or its files) not known to be gone yet
 *                       (`indexPending`); the site's hourly refresh settles it. Not only after a
 *                       hide that did not finish: an unhide that failed or died, or a new version
 *                       published into a hidden template, reads the same — so both ways out are offered;
 *  - `hidden`           hidden by its owner;
 *  - `listing`          public, its catalog entry not known to be written yet (within the hour);
 *  - `public`           public and listed.
 */
export type TemplateVisibilityState = "moderated" | "hidden-settling" | "hidden" | "listing" | "public";

export function templateVisibilityState(t: Pick<MineTemplate, "hidden" | "moderated" | "indexPending">): TemplateVisibilityState {
  if (t.moderated) return "moderated";
  if (t.hidden) return t.indexPending ? "hidden-settling" : "hidden";
  return t.indexPending ? "listing" : "public";
}

const LABEL: Record<TemplateVisibilityState, string> = {
  moderated: "Hidden by moderation",
  "hidden-settling": "Hidden — the catalog may show it for up to an hour",
  hidden: "Hidden",
  listing: "Public — listing soon",
  public: "Public",
};

/** What the running button's wait note says: a hide can be retried twice, an unhide is one attempt. */
export const WAIT_NOTE = {
  hide: "This can take a few minutes if the catalog is slow.",
  unhide: "This can take up to a minute if the catalog is slow.",
} as const;

const HIDE = { hidden: true, label: "Hide", busy: "Hiding…" } as const;
const HIDE_AGAIN = { hidden: true, label: "Hide again", busy: "Hiding…" } as const;
const SHOW_AGAIN = { hidden: false, label: "Show again", busy: "Showing…" } as const;
const CONTROLS: Record<TemplateVisibilityState, ReadonlyArray<{ hidden: boolean; label: string; busy: string }>> = {
  moderated: [],
  // Show again retries an unhide that failed (it works at once); Hide again finishes a hide now rather than at the refresh.
  "hidden-settling": [SHOW_AGAIN, HIDE_AGAIN],
  hidden: [SHOW_AGAIN],
  listing: [HIDE],
  public: [HIDE],
};

/**
 * One published template's visibility and its controls: Hide, Show again, or
 * — while a hidden template's catalog state settles — Show again and Hide
 * again. A moderated template gets no control at all: it says why when the
 * catalog stated a reason ("Removed — Copyright", and the operator's note),
 * and always links How to dispute — the Terms section that fits the reason
 * (`disputeLinkFor`). The server retries a hide's 5xx
 * (an unhide is sent once); nothing here changes before the catalog answers —
 * the row re-reads `/mine`.
 */
export function TemplateVisibility({
  template,
  className = "",
}: {
  template: Pick<MineTemplate, "id" | "hidden" | "moderated" | "indexPending" | "moderation">;
  /** Extra classes on the row (a card lets it wrap). */
  className?: string;
}) {
  const setHidden = useSetTemplateHidden();
  const state = templateVisibilityState(template);
  // Which of this row's buttons is running (the mutation is this row's own), so only it names the wait.
  const running = setHidden.isPending ? (setHidden.variables?.hidden ?? null) : null;
  return (
    <span data-testid={`template-visibility-${template.id}`} data-state={state} className={`inline-flex items-center gap-2 text-xs ${className}`}>
      {state === "moderated" ? (
        <Moderated moderation={template.moderation} />
      ) : (
        <span className={state === "hidden-settling" ? "text-amber-500" : "text-muted-foreground"}>{LABEL[state]}</span>
      )}
      {CONTROLS[state].map((c) => (
        <Button
          key={c.label}
          variant="ghost"
          size="xs"
          className="cursor-pointer"
          disabled={setHidden.isPending}
          onClick={() => setHidden.mutate({ cloudId: template.id, hidden: c.hidden })}
        >
          {running === c.hidden ? <BusyLabel>{c.busy}</BusyLabel> : c.label}
        </Button>
      ))}
      {/* The wait is named rather than left to a lone spinner, by direction
          (lib/templates/cloud/client.ts#setTemplateHidden): a hide is retried — up to
          three 60 s attempts — while an unhide is sent once and waits at most 60 s. */}
      {running !== null && (
        <span className="text-muted-foreground" data-testid={`template-visibility-wait-${template.id}`}>
          {WAIT_NOTE[running ? "hide" : "unhide"]}
        </span>
      )}
    </span>
  );
}

/**
 * The takedown date, as libi shows it beside a moderated template — Terms §11
 * counts the 14-day counter-notice window from it, so it must be the SAME
 * date the site counts from, wherever the user is: the UTC calendar date of
 * `moderation.at`, labelled "(UTC)" (a takedown at 20:00 UTC is the next day
 * east of UTC, so a local date could differ from the site's by a day).
 * `label` "26 Sep 2026 (UTC)" — day, English month, year, never a numeric
 * order a reader could flip, and not Intl's "Sept"; `full` the UTC date and
 * time, and the user's local time, for a tooltip; `iso` for `<time dateTime>`.
 * Null when `at` is missing or unreadable: no date rather than a wrong one.
 */
export function takedownDate(at: string | null | undefined): { label: string; full: string; iso: string } | null {
  if (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return null;
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  const label = utcDateLabel(d)!;
  let full: string;
  try {
    const utc = d.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" });
    const local = d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    full = `${utc} UTC (${local} your time)`;
  } catch {
    full = d.toISOString();
  }
  return { label, full, iso: d.toISOString() };
}

/** "on 26 Sep 2026 (UTC)", the full date and time in its tooltip; nothing when the date can't be read. */
export function TakedownDate({ at, testId, prefix = "on" }: { at: string | null | undefined; testId: string; prefix?: string }) {
  const date = takedownDate(at);
  if (!date) return null;
  return (
    <time dateTime={date.iso} title={date.full} data-testid={testId} className="whitespace-nowrap text-muted-foreground">
      {prefix} {date.label}
    </time>
  );
}

/** A note longer than this, or with a line break, is clamped to two lines with a "Show all" toggle. */
export const MODERATION_NOTE_PREVIEW_CHARS = 80;

/**
 * Where "How to dispute" goes, by why the template was removed — the section
 * of the Terms that fits the case:
 *  - `copyright` / `rights` → §11 (`#copyright`): the notice and
 *    counter-notice procedure for copyright and someone else's rights;
 *  - `illegal` / `terms` / `other`, `reports` (an automatic hide after
 *    reports, pending review), and a hide that came with no statement at all
 *    → §4A (`#templates-catalog`): what may be published, and "Moderation and
 *    removal" — how reports hide a template until it is reviewed. Never the
 *    copyright procedure, which does not fit them.
 */
export function disputeLinkFor(moderation: MineTemplate["moderation"], links: LegalLinks = LEGAL_LINKS): string {
  return moderation && (moderation.reason === "copyright" || moderation.reason === "rights") ? links.templatesDispute : links.templatesCatalogTerms;
}

/**
 * A moderated row: the stated reason when there is one, else the plain label,
 * and How to dispute either way — on the FIRST line, so it is always in view.
 * The operator's note (up to 500 characters, possibly several lines) goes on
 * its own line under them, wrapped in a capped width: the table's cells are
 * `whitespace-nowrap`, and an unwrapped note once stretched the Status column
 * past the screen and pushed the link off it. A long note shows two lines,
 * with the full text in its tooltip and behind "Show all".
 */
function Moderated({ moderation }: { moderation: MineTemplate["moderation"] }) {
  const links = useLegalLinks();
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();
  const note = moderation?.note ?? null;
  const long = note !== null && (note.length > MODERATION_NOTE_PREVIEW_CHARS || note.includes("\n"));
  return (
    <span className="flex max-w-72 flex-col items-start gap-0.5 whitespace-normal" data-testid="visibility-moderated">
      <span className="inline-flex flex-wrap items-center gap-x-2">
        {moderation ? (
          <>
            <span className="text-amber-500" title={MODERATED_MESSAGE} data-testid="visibility-removed">
              {moderationHeadline(moderation.reason)}
            </span>
            {/* Terms §11 counts the counter-notice window from this date. */}
            <TakedownDate at={moderation.at} testId="visibility-removed-date" />
          </>
        ) : (
          <span className="text-amber-500" title={MODERATED_MESSAGE}>
            {LABEL.moderated}
          </span>
        )}
        <a
          href={disputeLinkFor(moderation, links)}
          target="_blank"
          rel="noreferrer"
          data-testid="visibility-dispute"
          className="cursor-pointer whitespace-nowrap text-foreground underline underline-offset-2"
        >
          How to dispute
          <OpensOutside />
        </a>
      </span>
      {note && (
        <span className="max-w-full text-muted-foreground">
          <span
            id={noteId}
            data-testid="visibility-removed-note"
            data-expanded={expanded || !long}
            title={long && !expanded ? note : undefined}
            // `line-clamp-2` is its own display (-webkit-box): never combined with `block`, which would undo it.
            className={`break-words whitespace-pre-line [overflow-wrap:anywhere] ${long && !expanded ? "line-clamp-2" : "block"}`}
          >
            {note}
          </span>
          {long && (
            <button
              type="button"
              data-testid="visibility-removed-note-toggle"
              aria-expanded={expanded}
              aria-controls={noteId}
              onClick={() => setExpanded((v) => !v)}
              className="cursor-pointer text-foreground underline underline-offset-2"
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
