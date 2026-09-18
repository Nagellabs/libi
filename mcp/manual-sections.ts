/**
 * Sectioning for libi's agent manual (`renderAgentInstructions`).
 *
 * The manual is ~87 KB. Returned whole in one tool result, Claude Code spools
 * it to a file and the agent reads a fraction of it — which defeats the tiered
 * design, where the ≤1.9 KB MCP `instructions` core exists precisely so the
 * agent pulls the detail it needs through `libi.read_manual`.
 *
 * So the tool is sectioned: no argument returns an INDEX (one line per section
 * plus the workflow material an agent needs before its first edit, capped at
 * {@link DEFAULT_INDEX_BUDGET_BYTES}), a key returns one section, and `"all"`
 * still returns the whole thing for a client that can take it.
 *
 * Everything here is pure: text in, text out, no I/O and no logging — the
 * manual is rendered by the caller (`mcp/workspace.ts`).
 */

/** One top-level (`##`) section of the manual. */
export interface ManualSection {
  /** Lookup key shown in the index, e.g. `drawing-helper-functions`. */
  key: string;
  /** The heading text verbatim, without the leading `## `. */
  heading: string;
  /** First sentence under the heading, trimmed to ~100 chars. */
  description: string;
  /** The section's text, heading line included. */
  text: string;
  /** Size of `text` in UTF-8 bytes. */
  bytes: number;
}

/** The manual split into its lead-in and its sections. */
export interface SplitManual {
  /** Everything before the first `##` heading — the title and orientation. */
  preamble: string;
  sections: ManualSection[];
}

/**
 * Sections inlined verbatim into the no-argument index, in priority order —
 * what an agent needs before its FIRST edit. Deliberately NOT the big
 * reference material (`MCP Tools` is 25 KB, `Canvas Dimensions` 10 KB): those
 * are a single follow-up call away, and the tool description says so.
 *
 * Security and storyboard-first already live in the instructions core, so they
 * are not repeated here; these are the mechanics the core has no room for.
 *
 * A key that no longer matches a heading is silently skipped, so a unit test
 * pins every entry against the real rendered manual.
 */
export const ESSENTIAL_SECTION_KEYS: readonly string[] = [
  "workflow",
  "working-with-pieces",
  "canvas-coordinate-system",
  "planning-workflow-storyboard-first-for-video",
  "the-drawcontext",
  "draw-function-format",
];

/**
 * Byte ceiling for the no-argument index. Well inside the ~25 K-token result
 * budget that makes a client spool to disk, and roughly a sixth of the manual.
 *
 * Raised from 15_000 on 2026-09-18: the four essentials that must inline
 * (workflow, working-with-pieces, canvas-coordinate-system, planning-workflow)
 * had crept to 14.8 KB, so a 900-byte addition to the storyboard-first section
 * silently dropped that whole section from the index — the agent read the
 * DrawContext sections instead and never saw the gate. `manual-truth.test.ts`
 * now pins the planning section as inlined, so the next creep fails a test
 * rather than a user.
 */
export const DEFAULT_INDEX_BUDGET_BYTES = 16_384;

/** The reserved key that returns the manual unchanged. */
export const ALL_SECTIONS_KEY = "all";

/**
 * Section keys named as examples in prose OUTSIDE this module — the MCP
 * `instructions` core (`mcp/instructions-core.md`, plain text, can't import
 * this), the `libi.read_manual` tool description (`mcp/server.ts`), and its
 * schema description (`mcp/tools/schemas.ts`). Centralized here so the two
 * TypeScript surfaces build their examples FROM this array (no hand-typed
 * key can drift out of sync with it), and so a test can assert every key
 * still resolves against the real rendered manual. The `.md` is kept in
 * sync by hand — the test enforces that by regexing its quoted keys and
 * requiring each to be one of these. It names a SUBSET on purpose: the core
 * lives inside Claude Code's 2,048-character `instructions` budget, where the
 * other two surfaces are free to spell out every example.
 */
export const PROSE_EXAMPLE_SECTION_KEYS: readonly string[] = [
  "mcp-tools",
  "canvas-dimensions",
  "drawing-helper-functions",
  "object-tracking",
];

const HEADING_PREFIX = "## ";
const DESCRIPTION_MAX = 100;
/** Abbreviations whose trailing "." must not read as a sentence end. */
const ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "vs."];

/**
 * The stable, human-typable key for a heading: lowercased, every run of
 * non-alphanumerics collapsed to a single hyphen.
 */
export function sectionKeyForHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical form used for MATCHING a caller's `section` against a key. Drops
 * punctuation entirely rather than normalising it, so `"drawing api"`,
 * `"drawing-api"`, `"Drawing_API"` and `"Drawing API"` all collide.
 */
export function normalizeSectionKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Bytes rendered as `~1.4 KB`, for the index lines. */
function approxSize(bytes: number): string {
  return `~${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Tracks fenced-code-block state line by line, shared by {@link splitManual}
 * (a `##` inside a fence is not a heading) and {@link firstSentence} (a
 * fenced code sample is never a description). A fence marker is a run of
 * three or more `` ` `` or `~`, at any indentation (a fence nested in a list
 * item is commonly indented). A fence only CLOSES on a matching-character
 * marker: a ` ``` ` block containing a literal `~~~` line (or vice versa)
 * stays open, per CommonMark.
 */
class FenceTracker {
  private openChar: string | null = null;

  /** Feed the next line; returns true while inside a fence (the opening and
   *  closing marker lines both count as "inside" — they are body text, not
   *  headings or prose). */
  next(line: string): boolean {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (this.openChar === null) {
      if (marker) {
        this.openChar = marker[0];
        return true;
      }
      return false;
    }
    if (marker && marker[0] === this.openChar) {
      this.openChar = null;
    }
    return true;
  }
}

/**
 * The first `.`/`!`/`?` that ends a sentence in `flat`: not one that follows
 * a digit (so "1. Create the piece…" doesn't yield "1.") and not one that
 * closes a common abbreviation ({@link ABBREVIATIONS}) such as "(e.g." or
 * "i.e.". Falls back to the whole string when no real terminator is found.
 */
function extractFirstSentence(flat: string): string {
  const terminator = /[^\d\s][.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(flat))) {
    const candidate = flat.slice(0, match.index + match[0].length);
    const isAbbreviation = ABBREVIATIONS.some((abbr) =>
      candidate.toLowerCase().endsWith(abbr),
    );
    if (!isAbbreviation) return candidate;
  }
  return flat;
}

/**
 * First sentence of the body under a heading, flattened to one line and
 * trimmed to {@link DESCRIPTION_MAX}. Skips fenced code blocks (a code
 * sample is never a description) and `#`-prefixed heading lines (a
 * sub-heading right under the `##` heading, e.g. `### Example 1: …`, is not
 * prose) before picking the first paragraph. Sentence detection ignores a
 * `.` that follows a digit (an ordered list) and common abbreviations
 * ("e.g.", "i.e.", "etc.", "vs.") so those don't read as the sentence end.
 */
function firstSentence(body: string): string {
  const fence = new FenceTracker();
  const contentLines: string[] = [];
  for (const line of body.split("\n")) {
    const inFence = fence.next(line);
    if (inFence) continue;
    if (/^\s*#{1,6}\s/.test(line)) continue;
    contentLines.push(line);
  }

  const firstPara = contentLines.join("\n").trim().split(/\n\s*\n/)[0] ?? "";
  const flat = firstPara
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) return "";
  const sentence = extractFirstSentence(flat);
  return sentence.length > DESCRIPTION_MAX
    ? `${sentence.slice(0, DESCRIPTION_MAX).trimEnd()}…`
    : sentence;
}

/**
 * Split the rendered manual on its top-level `##` headings. `##` lines inside
 * fenced code blocks are body text, not headings.
 *
 * `##` is the level that yields ~25 sections of 0.2–25 KB on the current
 * manual; no section exceeds 30 KB, so no deeper split is needed.
 */
export function splitManual(manual: string): SplitManual {
  const lines = manual.split("\n");
  const starts: number[] = [];
  const fence = new FenceTracker();
  for (let i = 0; i < lines.length; i++) {
    const inFence = fence.next(lines[i]);
    if (!inFence && lines[i].startsWith(HEADING_PREFIX)) starts.push(i);
  }

  const preamble = lines.slice(0, starts.length > 0 ? starts[0] : lines.length).join("\n").trim();

  // Two headings can slug identically ("Foo" / "Foo 2" / "Foo" would
  // otherwise assign "foo" / "foo-2" / "foo-2" — the third COLLIDES with
  // the second's real key once normalized, making the third unreachable
  // through `resolveManualSection`). Keep incrementing the numeric suffix
  // until the NORMALIZED key — the form lookups actually match against — is
  // unused, so every section stays independently addressable.
  const usedKeys = new Set<string>();
  const sections: ManualSection[] = starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const heading = lines[start].slice(HEADING_PREFIX.length).trim();
    const text = lines.slice(start, end).join("\n").trimEnd();

    const base = sectionKeyForHeading(heading) || `section-${n + 1}`;
    let key = base;
    let suffix = 2;
    while (usedKeys.has(normalizeSectionKey(key))) {
      key = `${base}-${suffix}`;
      suffix++;
    }
    usedKeys.add(normalizeSectionKey(key));

    return {
      key,
      heading,
      description: firstSentence(lines.slice(start + 1, end).join("\n")),
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  });

  return { preamble, sections };
}

function fetchLine(): string {
  return 'Fetch any section with `libi.read_manual({ section: "<key>" })`';
}

/**
 * The no-argument response: the manual's orientation paragraph, one line per
 * section (key, description, approximate size), the essential sections
 * inlined, and — last — how to fetch the rest.
 *
 * Essentials are added in {@link ESSENTIAL_SECTION_KEYS} order while they fit
 * under `budgetBytes`; one that would overflow is skipped rather than ending
 * the loop, so a single oversized section does not hide the smaller ones
 * behind it.
 *
 * `budgetBytes` bounds ONLY that essentials loop. The head — preamble plus
 * the per-section index line for every section — and the footer are built
 * unconditionally, BEFORE the budget is ever checked; on a manual with
 * enough sections (or long enough descriptions), that head could exceed
 * `budgetBytes` all by itself. This function never throws for that: it
 * still returns the (unbounded) head and footer plus however many
 * essentials fit — zero, if the head has already used up the budget. So the
 * one hard guarantee is "no essential section pushes the result over
 * budget", not "the result never exceeds budget" — a test against the real
 * manual pins the real manual's index under {@link DEFAULT_INDEX_BUDGET_BYTES}
 * (`__tests__/unit/mcp/manual-sections.test.ts`), but that is a property of
 * the current manual's section count, not a guarantee this function makes
 * for an arbitrary one.
 */
export function renderManualIndex(
  manual: string,
  budgetBytes: number = DEFAULT_INDEX_BUDGET_BYTES,
): string {
  const { preamble, sections } = splitManual(manual);

  const head: string[] = [];
  if (preamble) head.push(preamble, "");
  head.push(
    `## Manual sections (${sections.length})`,
    "",
    ...sections.map((s) => {
      const desc = s.description ? ` — ${s.description}` : "";
      return `- \`${s.key}\` (${approxSize(s.bytes)})${desc}`;
    }),
    "",
    `- \`${ALL_SECTIONS_KEY}\` (${approxSize(Buffer.byteLength(manual, "utf8"))}) — the whole manual in one result.`,
    "",
    "The sections below are inlined because you need them before your first edit; everything else is one call away.",
  );

  const footer = `\n\n---\n\n${fetchLine()}`;
  const footerBytes = Buffer.byteLength(footer, "utf8");

  const parts = [head.join("\n")];
  let used = Buffer.byteLength(parts[0], "utf8") + footerBytes;

  const byKey = new Map(sections.map((s) => [normalizeSectionKey(s.key), s]));
  for (const key of ESSENTIAL_SECTION_KEYS) {
    const section = byKey.get(normalizeSectionKey(key));
    if (!section) continue;
    const cost = section.bytes + 2; // the "\n\n" join
    if (used + cost >= budgetBytes) continue;
    parts.push(section.text);
    used += cost;
  }

  return `${parts.join("\n\n")}${footer}`;
}

/** A resolved `libi.read_manual` response, or a message explaining the miss. */
export type ManualLookup = { ok: true; text: string } | { ok: false; message: string };

/**
 * Resolve one `libi.read_manual` call. No section (or a blank one) yields the
 * index; `"all"` the untouched manual; a key the single section. An unknown
 * key is an ERROR carrying the valid keys — never an empty success, which the
 * agent would read as "this section is empty".
 */
export function resolveManualSection(manual: string, section?: string): ManualLookup {
  const requested = (section ?? "").trim();
  if (requested.length === 0) return { ok: true, text: renderManualIndex(manual) };
  if (normalizeSectionKey(requested) === ALL_SECTIONS_KEY) return { ok: true, text: manual };

  const { sections } = splitManual(manual);
  const wanted = normalizeSectionKey(requested);
  const hit =
    sections.find((s) => normalizeSectionKey(s.key) === wanted) ??
    sections.find((s) => normalizeSectionKey(s.heading) === wanted);
  if (hit) return { ok: true, text: hit.text };

  const keys = [...sections.map((s) => s.key), ALL_SECTIONS_KEY].map((k) => `"${k}"`).join(", ");
  return {
    ok: false,
    message:
      `Unknown manual section "${requested}". Valid sections: ${keys}. ` +
      "Call `libi.read_manual` with no arguments for the index.",
  };
}
