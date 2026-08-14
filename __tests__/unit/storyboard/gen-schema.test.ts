import { describe, it, expect } from "vitest";
import { validateParams } from "@/lib/storyboard/gen-schema";
import type { GenFieldDef } from "@/lib/storyboard/gen-schema";

const fields: GenFieldDef[] = [
  { key: "prompt", type: "text", required: true },
  { key: "duration", type: "enum", options: [4, 6, 8] },
  { key: "cfg_scale", type: "number", min: 0, max: 1 },
  { key: "image_url", type: "image" },
  { key: "generate_audio", type: "boolean" },
];

describe("validateParams", () => {
  it("passes a conforming spec", () => {
    expect(validateParams({ prompt: "hi", duration: 8, cfg_scale: 0.5 }, fields)).toEqual([]);
  });
  it("flags an unknown key", () => {
    const issues = validateParams({ prompt: "hi", bogus: 1 }, fields);
    expect(issues).toEqual([{ key: "bogus", problem: "unknown_key", message: expect.any(String) }]);
  });
  it("flags a wrong type", () => {
    const issues = validateParams({ prompt: "hi", generate_audio: "yes" }, fields);
    expect(issues[0]).toMatchObject({ key: "generate_audio", problem: "wrong_type" });
  });
  it("flags a value not in options", () => {
    const issues = validateParams({ prompt: "hi", duration: 7 }, fields);
    expect(issues[0]).toMatchObject({ key: "duration", problem: "not_in_options" });
  });
  it("flags an out-of-range number", () => {
    const issues = validateParams({ prompt: "hi", cfg_scale: 2 }, fields);
    expect(issues[0]).toMatchObject({ key: "cfg_scale", problem: "out_of_range" });
  });
  it("flags a missing required field", () => {
    const issues = validateParams({ duration: 8 }, fields);
    expect(issues[0]).toMatchObject({ key: "prompt", problem: "missing_required" });
  });
  it("accepts a media value as a fileId string and an array when multiple", () => {
    const f: GenFieldDef[] = [{ key: "refs", type: "image", multiple: true }];
    expect(validateParams({ refs: ["a", "b"] }, f)).toEqual([]);
  });
});
