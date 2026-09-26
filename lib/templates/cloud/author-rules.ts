/**
 * The catalog's rules for a creator's own inputs — the key they paste and the
 * nickname they type — with no Node dependency, so the Settings card and the
 * Templates page can check them as the user types and the routes can refuse
 * the same values before anything reaches the site.
 */
import { NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import { edgeTextProblem, singleLineTextProblem } from "@/lib/templates/cloud/text-rules";

/** 43 chars base64url (256 bits). Re-exported by ./identity, which the server uses. */
export const CREATOR_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Enough to recognise a creator key by, not enough to use it: its first and last 4 characters. */
export function maskCreatorKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const NOT_A_CREATOR_KEY = "That isn't a creator key — a key is 43 characters of letters, digits, - and _.";

/**
 * A nickname as the user typed it, held to the site's rule
 * (libi-site lib/templates/shape.ts#parseNickname): trimmed, the shared text
 * rules (no control, bidi or TAG characters, nothing invisible at an edge),
 * runs of spaces collapsed to one, then 2–32 of A-Z a-z 0-9 space - _ with at
 * least one letter or digit. `nickname` is the value to send and store.
 */
export function parseNickname(raw: string): { ok: true; nickname: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (singleLineTextProblem(trimmed) !== null || edgeTextProblem(trimmed) !== null) {
    return { ok: false, error: "A nickname can't contain control, direction-changing or invisible characters." };
  }
  const nickname = trimmed.replace(/ {2,}/g, " ");
  if (!NICKNAME_PATTERN.test(nickname)) return { ok: false, error: "A nickname is 2 to 32 letters, digits, spaces, - or _." };
  if (!/[A-Za-z0-9]/.test(nickname)) return { ok: false, error: "A nickname needs at least one letter or digit." };
  return { ok: true, nickname };
}
