import { describe, it, expect } from "vitest";
import { buildParamView } from "@/lib/storyboard/param-view";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";
import type { GenSpec } from "@/lib/storyboard/types";

const schema: ModelSchema = {
  apiUrl: "u", model: "m",
  fields: [
    { key: "prompt", type: "text" },
    { key: "duration", type: "enum", options: [4, 6, 8] },
    { key: "start_frame", type: "image" },
    { key: "cfg_scale", type: "number", min: 0, max: 1 },
  ],
};

describe("buildParamView", () => {
  it("emits only present params, resolves type from schema, splits known vs unknown", () => {
    const spec: GenSpec = { apiUrl: "u", model: "m", params: { prompt: "hi", duration: 8, cfg_scale: 0.5 } };
    const view = buildParamView(spec, schema);
    const prompt = view.params.find((p) => p.key === "prompt")!;
    expect(prompt).toMatchObject({ type: "text", value: "hi", known: true, group: "Prompting", label: "Prompt" });
    const dur = view.params.find((p) => p.key === "duration")!;
    expect(dur).toMatchObject({ type: "enum", options: [4, 6, 8], known: true, group: "Parameters" });
    const cfg = view.params.find((p) => p.key === "cfg_scale")!;
    expect(cfg).toMatchObject({ type: "number", known: false });
    expect(view.params.find((p) => p.key === "start_frame")).toBeUndefined();
  });
  it("falls back to text type when no schema field exists for a present param", () => {
    const view = buildParamView({ apiUrl: "u", model: "m", params: { mystery: "x" } }, schema);
    expect(view.params.find((p) => p.key === "mystery")).toMatchObject({ type: "text", known: false });
  });
  it("returns empty for an undefined spec", () => {
    expect(buildParamView(undefined, schema).params).toEqual([]);
  });

  // Closed-list fallback for well-known constrained params (aspect ratio, duration)
  // when the cached schema field carries no options of its own.
  it("falls back to catalog options for aspect_ratio/duration when the schema lacks them", () => {
    const bare: ModelSchema = { apiUrl: "u", model: "m", fields: [{ key: "aspect_ratio", type: "text" }, { key: "duration", type: "number" }] };
    const view = buildParamView({ apiUrl: "u", model: "m", params: { aspect_ratio: "9:16", duration: 8 } }, bare);
    expect(view.params.find((p) => p.key === "aspect_ratio")!.options).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
    expect(view.params.find((p) => p.key === "duration")!.options).toEqual([3, 4, 5, 6, 8, 10]);
  });
  it("schema-provided options win over the catalog fallback", () => {
    const sch: ModelSchema = { apiUrl: "u", model: "m", fields: [{ key: "aspect_ratio", type: "enum", options: ["16:9", "9:16"] }] };
    const view = buildParamView({ apiUrl: "u", model: "m", params: { aspect_ratio: "16:9" } }, sch);
    expect(view.params.find((p) => p.key === "aspect_ratio")!.options).toEqual(["16:9", "9:16"]);
  });
  it("appends the current value to the fallback list when it's outside the closed set", () => {
    const bare: ModelSchema = { apiUrl: "u", model: "m", fields: [{ key: "duration", type: "number" }] };
    const view = buildParamView({ apiUrl: "u", model: "m", params: { duration: 7 } }, bare);
    expect(view.params.find((p) => p.key === "duration")!.options).toEqual([3, 4, 5, 6, 8, 10, 7]);
  });
});
