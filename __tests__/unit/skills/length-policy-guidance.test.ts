import { describe, it, expect } from "vitest";
import fs from "fs";

describe("length-policy guidance", () => {
  // The skills' side of this rule (ask before changing the piece's length) is an invariant in
  // skill-invariants.test.ts; this is the tool's own documentation of the same option.
  it("the audio_add_clip tool description documents lengthPolicy", () => {
    expect(fs.readFileSync("mcp/server.ts", "utf8")).toMatch(
      /Add an audio clip to the composition[\s\S]{0,600}lengthPolicy/,
    );
  });
});
