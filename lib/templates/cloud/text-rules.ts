// Mirrors libi-site lib/templates/text-rules.ts VERBATIM from the line below
// the marker. The app's ONE copy of the site's character rules: the publish
// preflight (lib/templates/cloud/preflight.ts) refuses exactly what the site
// refuses, so the agent hears it before any upload, and the catalog client
// (lib/templates/cloud/client.ts) holds what the site serves to the same rules.
// Change the site first, then copy the file body here unchanged.
// ---- copied from libi-site lib/templates/text-rules.ts ----
/**
 * The character rules for text a stranger writes and other people then see —
 * a template's name, description, slot labels, anything in its scaffold. One
 * copy, so the publish gate and the nickname route cannot drift apart.
 *
 * Refused everywhere:
 *  - C0 controls (except, in multi-line text, tab / LF / CR), DEL and C1;
 *  - the explicit bidi embedding / override / isolate controls U+202A-U+202E
 *    and U+2066-U+2069, which reorder what follows them and can make a name
 *    render as something else ("abc<RLO>gpj.exe" shows as "abcexe.jpg").
 *  - Unicode TAG characters U+E0000-U+E007F. They render as nothing, yet a
 *    language model reads them as ASCII — an invisible channel for
 *    instructions into the agent that reads the catalog. Their one standard
 *    use is allowed: the England, Scotland and Wales flags, exactly.
 * LRM / RLM (U+200E / U+200F) and the Arabic letter mark stay: they are marks
 * that right-to-left writers legitimately type, and they override nothing.
 *
 * Single-line text also refuses U+2028 / U+2029: they are line breaks by
 * another name.
 *
 * Both refuse more than MAX_COMBINING_MARKS combining marks (\p{M}) in a row
 * on one base character: "Zalgo" stacks that render far outside the line and
 * over the text around it. Real writing stays under it — Vietnamese stacks
 * two, pointed Hebrew with cantillation three, a Tibetan stack three, an
 * emoji keycap two (U+FE0F and U+20E3 are marks too), and Burmese, whose
 * medials, vowel signs and tone marks are all marks, five ("လျှို့ဝှက်",
 * "secret") and six at most (medial ya/ra, wa and ha, an upper and a lower
 * vowel sign, and the dot below).
 *
 * Messages returned here are printable ASCII, ready to append to a field name.
 */

/** The explicit bidi embedding, override and isolate controls. */
export const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;

const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const MULTI_LINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_SEPARATORS = /[\u2028\u2029]/;

const BIDI_MESSAGE = "may not contain bidi override or isolate characters (U+202A-U+202E, U+2066-U+2069)";

/** The most combining marks one base character may carry (final review Minor 10; 6 for Burmese, R1 Minor 3). */
export const MAX_COMBINING_MARKS = 6;
// Built at runtime: the site's TypeScript target predates `\p{…}` literals.
const COMBINING_STACK = new RegExp(`\\p{M}{${MAX_COMBINING_MARKS + 1},}`, "u");
export const COMBINING_MESSAGE = `may not stack more than ${MAX_COMBINING_MARKS} combining marks on one character`;

// The only standard TAG sequences, spelled out: U+1F3F4 WAVING BLACK FLAG, the
// tags "gbeng" / "gbsct" / "gbwls", then U+E007F CANCEL TAG. Nothing else — no
// other region, no longer run, no payload before the CANCEL TAG.
const SUBDIVISION_FLAGS = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const TAG_CHARACTER = /[\u{E0000}-\u{E007F}]/u;
export const TAG_MESSAGE = "may not contain Unicode tag characters (U+E0000-U+E007F) other than in the England, Scotland and Wales flags";

/** Whether `s` holds a TAG character outside the three subdivision flags. */
export function hasStrayTagCharacter(s: string): boolean {
  return TAG_CHARACTER.test(s.replace(SUBDIVISION_FLAGS, ""));
}

/** Why `s` is not acceptable single-line text (a name, a label), or null. */
export function singleLineTextProblem(s: string): string | null {
  if (SINGLE_LINE_CONTROLS.test(s)) return "may not contain control characters";
  if (LINE_SEPARATORS.test(s)) return "may not contain line breaks";
  if (BIDI_CONTROLS.test(s)) return BIDI_MESSAGE;
  if (hasStrayTagCharacter(s)) return TAG_MESSAGE;
  if (COMBINING_STACK.test(s)) return COMBINING_MESSAGE;
  return null;
}

/** Why `s` is not acceptable multi-line text (a description, a hint), or null. */
export function multiLineTextProblem(s: string): string | null {
  if (MULTI_LINE_CONTROLS.test(s)) return "may not contain control characters other than line breaks and tabs";
  if (BIDI_CONTROLS.test(s)) return BIDI_MESSAGE;
  if (hasStrayTagCharacter(s)) return TAG_MESSAGE;
  if (COMBINING_STACK.test(s)) return COMBINING_MESSAGE;
  return null;
}

// The three marks RTL writers legitimately type (LRM, RLM, ALM). They are
// format characters too, but allowed at an edge: only a run of them may sit
// there, never with an invisible character behind it.
const BIDI_MARKS = "[\\u200e\\u200f\\u061c]";
// Invisible: any format character (\p{Cf} — ZWSP, ZWNJ, ZWJ, WORD JOINER,
// BOM, soft hyphen, the invisible operators, TAG characters, …) other than
// those marks; the Hangul fillers, which are letters by category but render as
// blank space; and the non-Cf code points that render as nothing: U+034F
// COMBINING GRAPHEME JOINER, U+2800 BRAILLE PATTERN BLANK, and the Khmer
// inherent vowels U+17B4 / U+17B5. Built at runtime: the site's TypeScript
// target predates `\p{…}` literals.
const INVISIBLE = `(?:(?!${BIDI_MARKS})\\p{Cf}|[\\u115f\\u1160\\u3164\\uffa0\\u034f\\u2800\\u17b4\\u17b5])`;
// A variation selector (U+FE00-U+FE0F, U+E0100-U+E01EF) is invisible too, but
// only LEADING: after an emoji (U+2764 U+FE0F) it is how the emoji is drawn,
// while at the start there is nothing for it to select.
const VARIATION_SELECTOR = "[\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]";
const INVISIBLE_AT_EDGE = new RegExp(`^${BIDI_MARKS}*(?:${INVISIBLE}|${VARIATION_SELECTOR})|${INVISIBLE}${BIDI_MARKS}*$`, "u");

/**
 * Why `s` (already trimmed) is not acceptable at its edges, or null: it may
 * not start or end with an invisible character (see `INVISIBLE`; a variation
 * selector may not start it), not even behind a run of LRM / RLM / ALM, which
 * would pad a name or a description invisibly. Inside the text they stay (a ZWJ builds an emoji, ZWNJ is Persian
 * orthography), and LRM / RLM / ALM alone may sit at either edge — RTL writers
 * legitimately put them at the end of a line.
 */
export function edgeTextProblem(s: string): string | null {
  // The three subdivision flags end in TAG characters (\p{Cf}), yet each
  // renders as one visible flag — so each is collapsed to its base, U+1F3F4,
  // before the test. Any other TAG run stays, and counts as invisible.
  return INVISIBLE_AT_EDGE.test(s.replace(SUBDIVISION_FLAGS, "\u{1F3F4}"))
    ? "may not start or end with a zero-width or other invisible character (a Unicode format character other than LRM/RLM/ALM, a Hangul filler, a blank braille pattern, a grapheme joiner, a Khmer inherent vowel, or a leading variation selector)"
    : null;
}

/**
 * A name needs at least this many visible characters. "Visible" is one rule:
 * a letter or a digit (`\p{L}` or `\p{N}`), not counting the Hangul fillers
 * U+115F, U+1160, U+3164 and U+FFA0, which are letters by category but render
 * as blank space. Whitespace, format characters (zero-width space, soft
 * hyphen, joiners), punctuation, symbols and emoji do not count — they may
 * appear in a name, but cannot be all of it.
 */
export const MIN_VISIBLE_NAME_CHARS = 2;

const HANGUL_FILLERS = /[\u115f\u1160\u3164\uffa0]/g;
// Built at runtime: the site's TypeScript target predates `\p{…}` literals.
const LETTER_OR_DIGIT = new RegExp("[\\p{L}\\p{N}]", "gu");

/** How many visible characters (see `MIN_VISIBLE_NAME_CHARS`) `s` holds. */
export function visibleCharCount(s: string): number {
  return s.replace(HANGUL_FILLERS, "").match(LETTER_OR_DIGIT)?.length ?? 0;
}
