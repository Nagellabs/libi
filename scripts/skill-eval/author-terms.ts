import { FIXTURE_LEFT_OUT_AUTHOR_VALUES } from "@/lib/templates/cloud/left-out-fixture";

/**
 * Forbidden-paraphrase needles derived from a fixture's AUTHOR values, so a scenario's
 * "never repeat the author" check cannot drift from the fixture it tests.
 *
 * A scenario writes `{{author-terms:<source>}}` as an entry of a `transcript_contains`
 * list; the parser (`scenario.ts`) replaces it with `authorTermNeedles(<source's values>)`.
 * templates/06 is the reason: a hand list caught "sparkle" and "neon" and let "a glowing
 * outline", "a glow effect", "a burst exit" and "a sparkly exit" through.
 *
 * Only import-free modules may be read here (see `left-out-fixture.ts`).
 */
export const AUTHOR_TERM_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "left-out-fixture": Object.values(FIXTURE_LEFT_OUT_AUTHOR_VALUES),
};

/**
 * Tokens in an author value that are scaffolding rather than content — the fixture prefixes
 * every value with `author-` so it is recognisable in a transcript, and that prefix is not a
 * word the agent could only have taken from the author.
 */
const SCAFFOLD_TOKENS = new Set(["author"]);

/** Shortest stem kept: anything shorter would match ordinary words. */
const MIN_STEM = 3;

/**
 * The stem of one content word, short enough that every inflection of it contains the stem
 * as a substring: an inflectional suffix comes off ("glowing" → "glow", "bursts" → "burst"),
 * and a final silent "e" comes off too, because the suffixes that follow it drop it
 * ("sparkle" → "sparkl" matches sparkle, sparkles, sparkly, sparkling, sparkled).
 */
export function stemOf(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ing", "ed", "ly", "es", "s", "y"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= MIN_STEM + 1) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.endsWith("e") && w.length - 1 >= MIN_STEM + 1) w = w.slice(0, -1);
  return w;
}

/** Every distinct content stem in the values, lowercase, in first-seen order. */
export function authorTermStems(values: readonly string[]): string[] {
  const stems: string[] = [];
  for (const v of values) {
    for (const token of v.split(/[^A-Za-z]+/)) {
      if (!token || SCAFFOLD_TOKENS.has(token.toLowerCase())) continue;
      const stem = stemOf(token);
      if (stem.length >= MIN_STEM && !stems.includes(stem)) stems.push(stem);
    }
  }
  return stems;
}

/**
 * The `transcript_contains` needles for the values: each value verbatim, plus every stem in
 * lower, Capitalised and UPPER case (matching is case-sensitive substring). Any occurrence
 * of any needle is a hit.
 */
export function authorTermNeedles(values: readonly string[]): string[] {
  const out = new Set<string>(values);
  for (const s of authorTermStems(values)) {
    out.add(s);
    out.add(s[0].toUpperCase() + s.slice(1));
    out.add(s.toUpperCase());
  }
  return [...out];
}

const PLACEHOLDER = /^\{\{author-terms:([a-z0-9-]+)\}\}$/;

/**
 * Expand `{{author-terms:<source>}}` entries in one `transcript_contains` value. Throws on an
 * unknown source — a silently empty needle list would turn an `absent` check into a pass.
 */
export function expandAuthorTerms(value: string | string[]): string | string[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.some((v) => PLACEHOLDER.test(v))) return value;
  const out: string[] = [];
  for (const v of list) {
    const m = PLACEHOLDER.exec(v);
    if (!m) {
      out.push(v);
      continue;
    }
    const values = AUTHOR_TERM_SOURCES[m[1]];
    if (!values) {
      throw new Error(`unknown author-terms source "${m[1]}" (known: ${Object.keys(AUTHOR_TERM_SOURCES).join(", ")})`);
    }
    out.push(...authorTermNeedles(values));
  }
  return [...new Set(out)];
}
