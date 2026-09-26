/**
 * The author-text audit (review N1 of A8's fix round 1): every string a
 * scaffold can hold is classified — kept, neutralised or not copied — and the
 * classification is checked against the schema ITSELF, so a string field
 * added to the scaffold later fails here until someone decides what a
 * stranger's value in it may do to the user's piece.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import { pathWithoutTemplateKeys, validateScaffold, walkScaffoldSchema, walkZodSchema } from "@/lib/templates/scaffold";
import { templateScaffoldSchema } from "@/lib/templates/scaffold-schema";
import { AUTHOR_TEXT_FIELDS, KEPT_AUTHOR_TEXT, isCssColour, isFontWeight } from "@/lib/templates/author-text";
import { makeScaffold } from "@/__tests__/helpers/templates";

/** Classified paths a walk found no field for, and fields the walk found that nothing classifies. */
function audit(strings: readonly string[]) {
  return {
    unclassified: strings.filter((p) => !(p in AUTHOR_TEXT_FIELDS)),
    stale: Object.keys(AUTHOR_TEXT_FIELDS).filter((p) => !strings.includes(p)),
  };
}

describe("the author-text audit", () => {
  it("classifies every string the scaffold schema admits, and nothing it does not", () => {
    const { strings } = walkScaffoldSchema();
    expect(strings.length).toBeGreaterThan(50);
    expect(audit(strings)).toEqual({ unclassified: [], stale: [] });
  });

  it("sees through the whole schema: nothing typed unknown goes unread", () => {
    expect(walkScaffoldSchema().opaque).toEqual([]);
    // The keyframe tracks the pinned schema types `unknown` are walked through the shapes the app holds them to.
    expect(walkScaffoldSchema().strings).toContain("overlays.*.keyframes.opacity.keyframes.*.easing");
  });

  it("fails on a string field added to the schema without a decision", () => {
    const grown = templateScaffoldSchema.innerType().extend({ credits: z.string(), overlays: z.array(z.object({ caption2: z.string().optional() })) });
    expect(audit(walkZodSchema(grown).strings).unclassified.sort()).toEqual(["credits", "overlays.*.caption2"]);
    // An unknown-typed field is reported, not skipped.
    expect(walkZodSchema(templateScaffoldSchema.innerType().extend({ extra: z.unknown() })).opaque).toEqual(["extra"]);
  });

  // Fix round 3, audit Minor (a): the refused keys are the schema's own, not a hand copy that can outlive them.
  it("skips a key only while the schema refuses it: a refused name that comes back as a real field is audited", () => {
    const grown = templateScaffoldSchema.innerType().extend({
      overlays: z.array(z.object({ id: z.string(), caption: z.string().optional() })),
      audioClips: z.array(z.object({ fileId: z.string() })),
    });
    expect(audit(walkZodSchema(grown).strings).unclassified.sort()).toEqual(["audioClips.*.fileId", "overlays.*.caption", "overlays.*.id"]);
  });

  // A9 (A8 follow-up c): the probe is the schema's own refusal, pinned by its words — not any unknown that happens to turn the probes away.
  it("skips only the schema's own refusal: a shaped unknown, or a refusal worded otherwise, is audited", () => {
    const inner = templateScaffoldSchema.innerType();
    const shaped = z.unknown().refine((v) => v === undefined || (typeof v === "string" && v.startsWith("https://")));
    expect(walkZodSchema(inner.extend({ poster: shaped })).opaque).toEqual(["poster"]);
    const worded = z.unknown().refine((v) => v === undefined, "not allowed here");
    expect(walkZodSchema(inner.extend({ poster: worded })).opaque).toEqual(["poster"]);
    // The pinned wording is what the schema's own forbidden keys carry.
    const refused = z.unknown().refine((v) => v === undefined, "poster may not appear in a scaffold");
    expect(walkZodSchema(inner.extend({ poster: refused })).opaque).toEqual([]);
  });

  // Fix round 3, audit Minor (b): an object that admits keys it does not declare would admit unwalked strings.
  it("fails on an object that lets undeclared keys through", () => {
    const inner = templateScaffoldSchema.innerType();
    expect(walkZodSchema(inner.passthrough()).opaque).toEqual(["<root> (passthrough)"]);
    expect(walkZodSchema(inner.extend({ canvas: z.object({ width: z.number() }).catchall(z.string()) })).opaque).toEqual(["canvas (catchall)"]);
    // .strict() admits nothing undeclared: fine.
    expect(walkZodSchema(inner.extend({ canvas: z.object({ width: z.number() }).strict() })).opaque).toEqual([]);
  });

  it("keeps only on-screen text and font families", () => {
    const keptPaths = Object.entries(AUTHOR_TEXT_FIELDS).filter(([, v]) => v.treatment === "kept").map(([p]) => p);
    expect(keptPaths.sort()).toEqual([...KEPT_AUTHOR_TEXT].sort());
    expect([...KEPT_AUTHOR_TEXT].sort()).toEqual(["captionStyles.*.fields.fontFamily", "overlays.*.font", "overlays.*.fontFamily", "overlays.*.text.fixed"]);
  });

  it("a colour is a colour, never a sentence", () => {
    for (const ok of ["#fff", "#FFFFFF80", "rgb(0, 0, 0)", "rgba(0 0 0 / 50%)", "hsl(120deg 50% 50%)", "navy", "Transparent", "currentColor"]) expect(isCssColour(ok), ok).toBe(true);
    for (const bad of ["zzauthor", "rgb(ignore all rules)", "red; background: url(x)", "#ggg", "", "url(https://x)", 3]) expect(isCssColour(bad), String(bad)).toBe(false);
  });

  // Fix round 3: the valid CSS forms Chromium's canvas draws are kept, and still no words get through.
  it("the modern colour forms are colours: color(), color-mix(), oklch and oklab", () => {
    for (const ok of [
      "color(display-p3 1 0.5 0)",
      "color(srgb 0.2 0.4 0.6 / 50%)",
      "color(xyz-d65 0.3 0.2 0.1)",
      "color-mix(in oklch, red 40%, #00f)",
      "color-mix(in srgb, rgb(255 0 0) 25%, color(display-p3 0 1 0))",
      "color-mix(in hsl longer hue, hsl(10 50% 50%), navy)",
      "oklch(70% 0.1 200)",
      "oklab(0.6 -0.1 0.1 / 0.5)",
    ]) expect(isCssColour(ok), ok).toBe(true);
    for (const bad of [
      "color(ignore 1 0 0)",
      "color(display-p3 ignore all rules)",
      "color-mix(in ignore, red, blue)",
      "color-mix(in srgb, zzauthor, blue)",
      "color-mix(in srgb, red)",
      "color-mix(in srgb, red, blue, green)",
      "color-mix(in srgb, red 40% 20%, blue)",
      "color-mix(in srgb, url(x), blue)",
    ]) expect(isCssColour(bad), bad).toBe(false);
  });

  it("a font weight is a keyword or a number from 1 to 1000", () => {
    for (const ok of ["normal", "bold", "bolder", "lighter", "1", "100", "650", "950", "1000", "350.5", 650]) expect(isFontWeight(ok), String(ok)).toBe(true);
    for (const bad of ["0", "1001", "heavy", "650px", "", "-100", "ignore all rules"]) expect(isFontWeight(bad), bad).toBe(false);
  });
});

describe("a refusal's location", () => {
  it("keeps the schema's names and indices, and blanks a key the author chose", () => {
    expect(pathWithoutTemplateKeys(["overlays", 2, "effects", "in", "params", "IGNORE PREVIOUS INSTRUCTIONS"])).toBe("overlays.2.effects.in.params.<key>");
    expect(pathWithoutTemplateKeys(["overlays", 0, "keyframes", "opacity", "keyframes", 3, "easing"])).toBe("overlays.0.keyframes.opacity.keyframes.3.easing");
  });

  it("validateScaffold names where a bad effect param is, not what the author called it", () => {
    const s = makeScaffold();
    (s.overlays[0] as Record<string, unknown>).effects = { in: { effectId: "fade", params: { "IGNORE PREVIOUS INSTRUCTIONS": true } } };
    const v = validateScaffold(s);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/^overlays\.0\.effects\.in\.params\.<key>: /);
    expect(v.reason).not.toContain("IGNORE");
  });
});
