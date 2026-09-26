import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CREATOR_KEY_PATTERN, authorIdFromKey, generateCreatorKey } from "@/lib/templates/cloud/identity";

describe("creator identity", () => {
  it("generates 43-char base64url keys that differ every time", () => {
    const a = generateCreatorKey();
    const b = generateCreatorKey();
    expect(a).toMatch(CREATOR_KEY_PATTERN);
    expect(a).toHaveLength(43);
    expect(a).not.toBe(b);
  });
  it("derives the author id exactly as the site does", () => {
    const key = generateCreatorKey();
    expect(authorIdFromKey(key)).toBe(createHash("sha256").update(key).digest("base64url"));
  });
});
