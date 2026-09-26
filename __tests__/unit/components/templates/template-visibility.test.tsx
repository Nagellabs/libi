// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mutate = vi.fn();
const pending = vi.hoisted(() => ({ current: null as null | { hidden: boolean } }));
// The catalog view (a dev build's catalog switch) is not under test here: the build's own site's links, no view.
vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS } = await import("@/lib/legal-links");
  return { useLegalLinks: () => LEGAL_LINKS, useTemplatesCatalog: () => ({ data: undefined }) };
});
vi.mock("@/lib/queries/templates-cloud", () => ({
  useSetTemplateHidden: () => ({ mutate, isPending: pending.current !== null, variables: pending.current ? { cloudId: "x", hidden: pending.current.hidden } : undefined }),
}));
import {
  MODERATION_NOTE_PREVIEW_CHARS,
  TemplateVisibility,
  WAIT_NOTE,
  disputeLinkFor,
  takedownDate,
  templateVisibilityState,
} from "@/components/templates/templates-page/template-visibility";
import { OPENS_OUTSIDE_TEXT } from "@/components/templates/templates-page/opens-outside";
import { LEGAL_LINKS } from "@/lib/legal-links";
import { MODERATION_REASON_LABELS } from "@/lib/templates/cloud/constants";

const ID = "abcdefghijklmnopqrst";
const t = (hidden: boolean, moderated: boolean, indexPending: boolean) => ({ id: ID, hidden, moderated, indexPending });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pending.current = null;
});

describe("templateVisibilityState", () => {
  it("reads /mine: moderation wins; a hidden template still pending in the index is a hide to repeat", () => {
    expect(templateVisibilityState(t(true, true, false))).toBe("moderated");
    expect(templateVisibilityState(t(true, true, true))).toBe("moderated");
    expect(templateVisibilityState(t(true, false, true))).toBe("hidden-settling");
    expect(templateVisibilityState(t(true, false, false))).toBe("hidden");
    expect(templateVisibilityState(t(false, false, true))).toBe("listing");
    expect(templateVisibilityState(t(false, false, false))).toBe("public");
  });
});

describe("TemplateVisibility", () => {
  it("a moderated template says so and offers no control at all", () => {
    render(<TemplateVisibility template={t(true, true, false)} />);
    expect(screen.getByText("Hidden by moderation")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Site fix round 3: hidden + indexPending also follows an unhide that failed or died (files retired,
  // the flag left for the hourly refresh), or a new version published into a hidden template — so the
  // row claims no cause, and offers the retry that works at once as well as Hide again.
  it("a hidden template still settling says only what is true, and offers Show again and Hide again", () => {
    render(<TemplateVisibility template={t(true, false, true)} />);
    const label = screen.getByText("Hidden — the catalog may show it for up to an hour");
    expect(label).toBeInTheDocument();
    expect(screen.queryByText(/didn.t finish/i)).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Show again", "Hide again"]);
    fireEvent.click(screen.getByRole("button", { name: "Show again" }));
    expect(mutate).toHaveBeenLastCalledWith({ cloudId: ID, hidden: false });
    fireEvent.click(screen.getByRole("button", { name: "Hide again" }));
    expect(mutate).toHaveBeenLastCalledWith({ cloudId: ID, hidden: true });
  });

  it("a public template not yet listed says it lists soon, and offers Hide", () => {
    render(<TemplateVisibility template={t(false, false, true)} />);
    expect(screen.getByText("Public — listing soon")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Hide"]);
  });

  it("offers Show again for an owner-hidden template, and Hide for a public one", () => {
    render(<TemplateVisibility template={t(true, false, false)} />);
    fireEvent.click(screen.getByRole("button", { name: "Show again" }));
    expect(mutate).toHaveBeenLastCalledWith({ cloudId: ID, hidden: false });
    cleanup();
    render(<TemplateVisibility template={t(false, false, false)} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(mutate).toHaveBeenLastCalledWith({ cloudId: ID, hidden: true });
  });

  // Final review m3: a hide is retried (up to three 60 s attempts); an unhide is sent once, ≤ 60 s.
  it("names the wait by direction: a hide can take a few minutes, an unhide up to a minute", () => {
    pending.current = { hidden: true };
    render(<TemplateVisibility template={t(false, false, false)} />);
    expect(screen.getByTestId(`template-visibility-wait-${ID}`)).toHaveTextContent(WAIT_NOTE.hide);
    expect(WAIT_NOTE.hide).toMatch(/few minutes/);
    cleanup();
    pending.current = { hidden: false };
    render(<TemplateVisibility template={t(true, false, false)} />);
    const note = screen.getByTestId(`template-visibility-wait-${ID}`);
    expect(note).toHaveTextContent(WAIT_NOTE.unhide);
    expect(note.textContent).not.toMatch(/minutes/);
    expect(note.textContent).toMatch(/up to a minute/);
    cleanup();
    pending.current = null;
    render(<TemplateVisibility template={t(true, false, false)} />);
    expect(screen.queryByTestId(`template-visibility-wait-${ID}`)).toBeNull();
  });
});

// The statement of reasons (Terms §11): why WE took it down, and how to dispute it.
describe("TemplateVisibility — removed by moderation", () => {
  const AT = "2026-09-30T10:00:00.000Z";
  const removed = (moderation: unknown) => ({ ...t(true, true, false), moderation }) as Parameters<typeof TemplateVisibility>[0]["template"];

  it("names the reason, shows the operator's note, and links How to dispute to the Terms §11, in a new tab", () => {
    render(<TemplateVisibility template={removed({ reason: "copyright", note: "DMCA notice of 2026-09-30", at: AT })} />);
    expect(screen.getByTestId("visibility-removed")).toHaveTextContent("Removed — Copyright");
    expect(screen.queryByText("Hidden by moderation")).toBeNull();
    expect(screen.getByText("DMCA notice of 2026-09-30")).toBeInTheDocument();
    const link = screen.getByTestId("visibility-dispute");
    expect(link).toHaveTextContent("How to dispute");
    // It leaves libi, and says so: the icon, and the words for a screen reader.
    expect(screen.getByRole("link", { name: `How to dispute ${OPENS_OUTSIDE_TEXT}` })).toBe(link);
    expect(link).toHaveAttribute("href", LEGAL_LINKS.templatesDispute);
    expect(link.getAttribute("href")).toMatch(/\/terms#copyright$/);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveClass("cursor-pointer");
    // Still no control: only an operator shows it again (a short note has no Show all either).
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("every reason has its label", () => {
    expect(MODERATION_REASON_LABELS).toEqual({
      copyright: "Copyright",
      rights: "Someone else's rights",
      illegal: "Illegal content",
      terms: "Breaks the Terms",
      other: "Other",
      reports: "Hidden after reports — pending review",
    });
    for (const [reason, label] of Object.entries(MODERATION_REASON_LABELS)) {
      if (reason === "reports") continue;
      render(<TemplateVisibility template={removed({ reason, note: null, at: AT })} />);
      expect(screen.getByTestId("visibility-removed")).toHaveTextContent(`Removed — ${label}`);
      cleanup();
    }
  });

  // The site's automatic hide after reports states `reports` — not a decision yet, so not "Removed". Terms §11 quotes the words.
  it("an automatic hide after reports reads exactly \"Hidden after reports — pending review\", and How to dispute goes to §4A", () => {
    render(<TemplateVisibility template={removed({ reason: "reports", note: null, at: AT })} />);
    expect(screen.getByTestId("visibility-removed").textContent).toBe("Hidden after reports — pending review");
    expect(screen.getByTestId("visibility-dispute")).toHaveAttribute("href", LEGAL_LINKS.templatesCatalogTerms);
    expect(LEGAL_LINKS.templatesCatalogTerms).toMatch(/\/terms#templates-catalog$/);
  });

  // Terms §11 counts the 14-day counter-notice window from "the takedown date libi shows".
  it("shows the takedown date beside the reason — '26 Sep 2026 (UTC)', the full date and time in its tooltip — and no date when it can't be read", () => {
    const at = "2026-09-26T05:30:00.000Z";
    render(<TemplateVisibility template={removed({ reason: "copyright", note: null, at })} />);
    const shown = screen.getByTestId("visibility-removed-date");
    expect(shown.textContent).toBe("on 26 Sep 2026 (UTC)");
    expect(shown.getAttribute("datetime")).toBe(at);
    expect(shown.getAttribute("title")).toMatch(/September 2026/);
    expect(shown.getAttribute("title")).toMatch(/\d{2}:\d{2}/);
    cleanup();
    render(<TemplateVisibility template={removed({ reason: "reports", note: null, at })} />);
    expect(screen.getByTestId("visibility-removed").textContent).toBe("Hidden after reports — pending review");
    expect(screen.getByTestId("visibility-removed-date")).toBeInTheDocument();
    cleanup();
    for (const bad of ["", "not a date", "2026-13-45T99:00:00Z", "26/09/2026", undefined]) {
      render(<TemplateVisibility template={removed({ reason: "terms", note: null, at: bad as string })} />);
      expect(screen.getByTestId("visibility-removed")).toBeInTheDocument();
      expect(screen.queryByTestId("visibility-removed-date"), String(bad)).toBeNull();
      cleanup();
    }
  });

  it("takedownDate: the UTC day, English month and year, labelled (UTC) — never Intl's 'Sept' — or null", () => {
    for (const [iso, month] of [["2026-09-15T12:00:00.000Z", "Sep"], ["2026-01-15T12:00:00.000Z", "Jan"], ["2026-12-15T12:00:00.000Z", "Dec"]] as const) {
      expect(takedownDate(iso)!.label).toBe(`15 ${month} 2026 (UTC)`);
    }
    // The site's day, wherever the user is (fix-round review N8): 20:00 UTC stays that day even east of UTC,
    // and 01:00 UTC stays that day even west of it — whatever this machine's zone.
    expect(takedownDate("2026-09-26T20:00:00.000Z")!.label).toBe("26 Sep 2026 (UTC)");
    expect(takedownDate("2026-09-26T01:00:00.000Z")!.label).toBe("26 Sep 2026 (UTC)");
    expect(takedownDate("2026-09-26T20:00:00.000Z")!.full).toMatch(/26 September 2026.*20:00 UTC/);
    expect(takedownDate(null)).toBeNull();
    expect(takedownDate("Sep 26 2026")).toBeNull();
  });

  it("no note: no empty line for it", () => {
    render(<TemplateVisibility template={removed({ reason: "rights", note: null, at: AT })} />);
    expect(screen.queryByTestId("visibility-removed-note")).toBeNull();
  });

  // BC review M4: a hide by reports (spam, broken, …) is not a copyright takedown.
  it("without a statement (auto-hidden by reports, or an older site) it stays 'Hidden by moderation', with How to dispute — NOT to the copyright section", () => {
    for (const moderation of [null, undefined]) {
      render(<TemplateVisibility template={removed(moderation)} />);
      expect(screen.getByText("Hidden by moderation")).toBeInTheDocument();
      expect(screen.queryByTestId("visibility-removed")).toBeNull();
      const href = screen.getByTestId("visibility-dispute").getAttribute("href");
      expect(href).toBe(LEGAL_LINKS.templatesCatalogTerms);
      expect(href).not.toMatch(/#copyright$/);
      cleanup();
    }
  });

  it("How to dispute goes to the Terms section that fits the reason", () => {
    const at = AT;
    expect(disputeLinkFor({ reason: "copyright", note: null, at })).toBe(LEGAL_LINKS.templatesDispute);
    expect(disputeLinkFor({ reason: "rights", note: null, at })).toBe(LEGAL_LINKS.templatesDispute);
    for (const reason of ["illegal", "terms", "other", "reports"] as const) {
      expect(disputeLinkFor({ reason, note: null, at }), reason).toBe(LEGAL_LINKS.templatesCatalogTerms);
      render(<TemplateVisibility template={removed({ reason, note: null, at })} />);
      expect(screen.getByTestId("visibility-dispute")).toHaveAttribute("href", LEGAL_LINKS.templatesCatalogTerms);
      cleanup();
    }
    expect(disputeLinkFor(null)).toBe(LEGAL_LINKS.templatesCatalogTerms);
    expect(LEGAL_LINKS.templatesCatalogTerms).toMatch(/\/terms#templates-catalog$/);
  });

  // BC review I1: the cell is whitespace-nowrap; an unwrapped 500-character note pushed the link off screen.
  // jsdom can't lay out — this pins the structure the real render depends on (checked in Chromium, see the report).
  it("a long, multi-line note wraps under the reason and the link, clamped to two lines, with the whole note behind Show all", () => {
    const note = `Removed after a DMCA notice from a record label about the music in the example video.\n${"You can send a counter-notice. ".repeat(14)}`.slice(0, 500);
    render(<TemplateVisibility template={removed({ reason: "copyright", note, at: AT })} />);
    const block = screen.getByTestId("visibility-moderated");
    expect(block).toHaveClass("whitespace-normal", "max-w-72");
    // The link sits on the first line, with the reason — before the note.
    const link = screen.getByTestId("visibility-dispute");
    const shown = screen.getByTestId("visibility-removed-note");
    expect(link.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.parentElement).toBe(screen.getByTestId("visibility-removed").parentElement);
    expect(shown).toHaveClass("line-clamp-2", "break-words", "whitespace-pre-line");
    expect(shown).toHaveAttribute("title", note);
    expect(shown.textContent).toBe(note);
    const toggle = screen.getByTestId("visibility-removed-note-toggle");
    expect(toggle).toHaveTextContent("Show all");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", shown.id);
    expect(toggle).toHaveClass("cursor-pointer");
    fireEvent.click(toggle);
    expect(shown).not.toHaveClass("line-clamp-2");
    expect(toggle).toHaveTextContent("Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("a short one-line note shows whole, with no toggle", () => {
    const note = "x".repeat(MODERATION_NOTE_PREVIEW_CHARS);
    render(<TemplateVisibility template={removed({ reason: "terms", note, at: AT })} />);
    expect(screen.getByTestId("visibility-removed-note")).not.toHaveClass("line-clamp-2");
    expect(screen.queryByTestId("visibility-removed-note-toggle")).toBeNull();
  });

  it("a template that isn't moderated shows no dispute link, even with a stale statement", () => {
    for (const [hidden, indexPending] of [[true, false], [true, true], [false, true], [false, false]] as const) {
      render(<TemplateVisibility template={{ ...t(hidden, false, indexPending), moderation: { reason: "copyright", note: "stale", at: AT } }} />);
      expect(screen.queryByTestId("visibility-dispute")).toBeNull();
      expect(screen.queryByTestId("visibility-removed")).toBeNull();
      cleanup();
    }
  });
});
