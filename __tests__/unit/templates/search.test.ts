import { describe, it, expect } from "vitest";
import { tokenize, buildMatchExpression } from "@/lib/templates/search";

describe("template search tokenizer", () => {
  it("lowercases, splits on non-alphanumerics, drops empties and caps at 8 tokens", () => {
    expect(tokenize("  Lower-Third, promo! ")).toEqual(["lower", "third", "promo"]);
    expect(tokenize("a b c d e f g h i j")).toHaveLength(8);
  });
  it("builds a prefix AND expression and quotes every token", () => {
    expect(buildMatchExpression(["lower", "third"])).toBe('"lower"* "third"*');
    expect(buildMatchExpression([])).toBeNull();
  });
  it("cannot be broken out of with FTS operators", () => {
    expect(buildMatchExpression(tokenize('x" OR "y'))).toBe('"x"* "or"* "y"*');
  });
  it("keeps letters and digits of any script, still splits on punctuation and still escapes FTS syntax", () => {
    expect(tokenize("כתובית תחתונה")).toEqual(["כתובית", "תחתונה"]);
    expect(tokenize("Привет, мир")).toEqual(["привет", "мир"]);
    expect(tokenize("café-crème 2")).toEqual(["café", "crème", "2"]);
    expect(buildMatchExpression(tokenize('ש" OR "y'))).toBe('"ש"* "or"* "y"*');
  });
  it("keeps combining marks inside a word (Devanagari, Thai), so FTS5 matches the word as one adjacent-token phrase", () => {
    // U+094D virama and U+0940 vowel sign are \p{M}: splitting on them would cut the word apart.
    expect(tokenize("हिन्दी शीर्षक")).toEqual(["हिन्दी", "शीर्षक"]);
    expect(tokenize("คำบรรยาย")).toEqual(["คำบรรยาย"]);
    // A decomposed é (e + U+0301) is one token, normalised to the composed form.
    expect(tokenize("cafe\u0301")).toEqual(["café"]);
  });
  it("CJK and Greek queries tokenize to something (they used to list every template)", () => {
    expect(tokenize("字幕 标题")).toEqual(["字幕", "标题"]);
    expect(tokenize("Τίτλος")).toEqual(["τίτλος"]);
  });
});
