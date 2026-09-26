/**
 * `placeholderBodyFor` writes the stand-in body a tracked overlay with
 * non-code content becomes on extract. The track label (or `displayName`, or
 * the track id) goes into a `//` comment in that body — so a label carrying a
 * line terminator used to end the comment and turn the rest of the label into
 * body code (sandbox-merge review M4). Every JS line terminator is covered:
 * CR, LF, U+2028, U+2029.
 */
import { describe, it, expect } from "vitest";
import { placeholderBodyFor } from "@/lib/templates/extract";

const EMOJI = { kind: "emoji", char: "😀" } as Parameters<typeof placeholderBodyFor>[0];
const PAYLOAD = "globalThis.__placeholderPwned = 1; //";

/** Lines that are not a `//` comment, splitting on every JS line terminator. */
function codeLines(body: string): string[] {
  return body
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
}

function runBody(body: string): void {
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  new Function("context", body)({ ctx, width: 100, height: 100 });
}

describe("placeholderBodyFor", () => {
  const baseline = codeLines(placeholderBodyFor(EMOJI, "lisa"));

  for (const [name, sep] of [
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ] as const) {
    it(`keeps a label with ${name} + code inside the comment — the only code is the placeholder`, () => {
      const body = placeholderBodyFor(EMOJI, `lisa${sep}${PAYLOAD}`);
      expect(codeLines(body)).toEqual(baseline);
      expect(body).not.toMatch(/[\r\u2028\u2029]/);
      expect(body.split("\n")[0]).toContain(PAYLOAD);

      delete (globalThis as Record<string, unknown>).__placeholderPwned;
      runBody(body);
      expect((globalThis as Record<string, unknown>).__placeholderPwned).toBeUndefined();
    });
  }

  it("keeps text content with a line separator inside its string literal, escaped", () => {
    const body = placeholderBodyFor(
      { kind: "text", content: `hi\u2028${PAYLOAD}` } as Parameters<typeof placeholderBodyFor>[0],
      "lisa",
    );
    expect(body).not.toMatch(/[\u2028\u2029]/);
    expect(body).toContain("\\u2028");
    expect(codeLines(body)).toHaveLength(baseline.length);
    delete (globalThis as Record<string, unknown>).__placeholderPwned;
    runBody(body);
    expect((globalThis as Record<string, unknown>).__placeholderPwned).toBeUndefined();
  });
});
