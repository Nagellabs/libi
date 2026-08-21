/**
 * The definition is the film. These assertions are the difference between
 * "the build succeeded" and "the build produced the video we meant".
 *
 * The 52-second runtime is the one most likely to be silently lost: the six
 * background layers only cover the first 30 s, and the rest exists purely
 * because the finale overlays run past them. `getCompositionFrames` is the
 * latest overlay or audio end — so a single mis-copied duration shortens the
 * film with nothing else failing.
 */
import { describe, it, expect } from "vitest";
import { ONBOARDING_PIECE_V1 } from "@/lib/onboarding/piece/v1";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";
import { getCompositionFrames } from "@/lib/engine/renderer";
import { BUNDLED_FONT_FAMILIES } from "@/lib/fonts/bundled";
import { familyFromFont, GENERIC_CSS_FAMILIES } from "@/lib/fonts/resolve";
import { parseFontShorthand } from "@/lib/fonts/family";
import { endTimeMs, toMs } from "@/lib/onboarding/piece/types";

const D = ONBOARDING_PIECE_V1;

/** Every slug the definition names, from any position. */
function referencedSlugs(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "assetSlug" && typeof val === "string") out.push(val);
        else walk(val);
      }
    }
  };
  walk(D);
  return out;
}

describe("onboarding v1 definition — shape", () => {
  it("is the 1920x1080/30fps piece named Welcome to libi", () => {
    expect(D.name).toBe("Welcome to libi");
    expect([D.width, D.height, D.fps]).toEqual([1920, 1080, 30]);
    expect(D.version).toBe("v1");
  });

  it("has 6 beats covering the first 30.0 s, laid end to end", () => {
    expect(D.beats).toHaveLength(6);
    expect(D.beats.map((b) => b.duration)).toEqual([4, 6, 6, 8, 2.5, 3.5]);
    expect(D.beats.map((b) => b.startTime)).toEqual([0, 4, 10, 16, 24, 26.5]);
    const end = Math.max(...D.beats.map((b) => b.startTime + b.duration));
    expect(end).toBeCloseTo(30.0, 6);
  });

  it("has 26 overlays and 15 audio clips", () => {
    expect(D.overlays).toHaveLength(26);
    expect(D.audioClips).toHaveLength(15);
  });

  it("ships NO object track and NO tracked overlay", () => {
    // The replacement for "has 1 track". Slot D's reticle used to be a real
    // `tracked` overlay over a real 145-sample track; it is now a plain `code`
    // overlay with those boxes baked into its draw function. Two reasons, and
    // both of them are about the user rather than the file: object tracking
    // provisions a local model the first time it runs, which a brand-new user
    // has not installed, and a live tracked overlay puts tracking controls in
    // their inspector for a track they cannot regenerate.
    //
    // Asserted three ways because there are three ways for it to come back —
    // the field, the overlay kind, and a dangling `trackId` reference.
    expect(D).not.toHaveProperty("tracks");
    expect(D.overlays.filter((o) => o.kind === "tracked")).toHaveLength(0);
    expect(JSON.stringify(D)).not.toContain('"trackId"');
  });

  it("draws slot D's reticle from a baked box per rendered frame", () => {
    // The other half of the guarantee: dropping the track must not have
    // dropped the reticle. The boxes are what the engine's own placement path
    // resolved for the tracked overlay, one row per frame of its window.
    const reticle = D.overlays.find((o) => o.id === "code-c5da91a2");
    expect(reticle, "the baked reticle overlay is missing").toBeDefined();
    expect(reticle!.kind).toBe("code");
    const draw = (reticle as unknown as { drawFunction: string }).drawFunction;

    // One row per rendered frame of the overlay, plus the closing frame.
    const rows = draw.match(/\n\s*\[[-\d.]+, [-\d.]+, [-\d.]+, [-\d.]+\],/g) ?? [];
    expect(rows).toHaveLength(Math.round(reticle!.duration * D.fps) + 1);

    // The boxes are composition coordinates, so they must land inside the
    // frame — the failure this replaced was a box drawn at SOURCE scale.
    for (const row of rows) {
      const [x, y, w, h] = row.replace(/[^\d.,-]/g, "").split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(D.width);
      expect(y + h).toBeLessThanOrEqual(D.height);
    }

    // The reticle body itself came through verbatim — the label chip is the
    // cheapest proof the wrap did not eat it.
    expect(draw).toContain("track: sneaker");
  });

  it("every background layer carries real draw code", () => {
    const backgrounds = D.overlays.filter((o) => o.z === 0);
    expect(backgrounds).toHaveLength(6);
    for (const o of backgrounds) {
      expect((o as unknown as { drawFunction: string }).drawFunction.length, o.id)
        .toBeGreaterThan(200);
    }
  });
});

describe("onboarding v1 definition — the 52-second runtime", () => {
  it("runs 1560 frames (52.0 s), well past the 30 s of background layers", () => {
    // The tail is the whole point: the end card has to stay on screen long
    // enough for a new user to read the download lines.
    expect(getCompositionFrames(D as never)).toBe(1560);
  });

  it("holds the seven end-card overlays to exactly 52.000", () => {
    // `endTimeMs` / `toMs` are the same helpers the extractor uses to derive
    // this count for the generated header — one rounding for one concept, so
    // the file and the test cannot disagree about where the film ends.
    const held = D.overlays.filter((o) => endTimeMs(o) === toMs(52));
    expect(held).toHaveLength(7);
  });

  it("ends its audio at 42.0 — the last 10 s are a deliberate silent hold", () => {
    const lastAudioEnd = Math.max(...D.audioClips.map((c) => c.startTime + c.duration));
    expect(lastAudioEnd).toBeCloseTo(42.0, 6);
  });
});

describe("onboarding v1 definition — assets", () => {
  it("names only slugs that exist, and no fileIds", () => {
    const known = new Set(ONBOARDING_ASSETS_V1.map((a) => a.slug));
    for (const slug of referencedSlugs()) expect(known, slug).toContain(slug);
    expect(JSON.stringify(D)).not.toContain('"fileId"');
    // A raw UUID would mean a machine-local id leaked into the definition.
    expect(JSON.stringify(D)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("references every asset it ships — nothing is dead weight", () => {
    const used = new Set(referencedSlugs());
    for (const a of ONBOARDING_ASSETS_V1) {
      expect(used, `${a.slug} is published but never rendered`).toContain(a.slug);
    }
  });
});

describe("onboarding v1 definition — voice-over and ducking", () => {
  const voIds = ["clip_vo1", "clip_vo2", "clip_vo3", "clip_vo4", "clip_vo5", "clip_vo6"];

  it("places the six lines at their measured offsets", () => {
    const starts = voIds.map((id) => D.audioClips.find((c) => c.id === id)?.startTime);
    expect(starts).toEqual([1.0, 5.0, 11.0, 17.0, 24.6, 37.3]);
  });

  it("ducks both music beds against all six lines", () => {
    const ducked = D.audioClips.filter((c) => c.duck);
    expect(ducked).toHaveLength(2);
    for (const c of ducked) {
      expect(c.duck?.sidechainClipIds, c.id).toEqual(voIds);
    }
  });

  it("ships no VO bus", () => {
    // The bus existed only because ducking took one sidechain. It no longer does.
    expect(JSON.stringify(D)).not.toContain("vo-bus");
  });

  it("points every sidechain id at a clip that exists", () => {
    const ids = new Set(D.audioClips.map((c) => c.id));
    for (const c of D.audioClips) {
      for (const s of c.duck?.sidechainClipIds ?? []) expect(ids, s).toContain(s);
    }
  });
});

describe("onboarding v1 definition — fonts", () => {
  it("names only bundled families in overlay properties", () => {
    // The original build asked for families nobody has and got a serif.
    //
    // Walks the definition rather than regexing `JSON.stringify(D)`. The
    // regex form cannot match a value containing an escaped inner quote —
    // `"font":"48px \"JetBrains Mono\""` — which is the SAME blindness the
    // draw-code test below had to fix, and it has no business surviving next
    // to its own fix. Walking has no escaping to get wrong.
    const fonts: { where: string; key: string; value: string }[] = [];
    const walk = (v: unknown, where: string): void => {
      if (Array.isArray(v)) return void v.forEach((x) => walk(x, where));
      if (!v || typeof v !== "object") return;
      const obj = v as Record<string, unknown>;
      const owner = typeof obj.id === "string" ? obj.id : where;
      for (const [k, val] of Object.entries(obj)) {
        if ((k === "font" || k === "fontFamily") && typeof val === "string") {
          fonts.push({ where: owner, key: k, value: val });
        } else walk(val, owner);
      }
    };
    walk(D, "definition");

    // A real floor, not `> 0`. Seven text overlays each carry both `font` and
    // `fontFamily`; losing all but one of them used to still pass, which is
    // the vacuous-pass trap this suite has already fallen into once.
    expect(fonts.length).toBeGreaterThanOrEqual(14);

    for (const { where, key, value } of fonts) {
      // Two spellings live under these keys and only one is a shorthand:
      // `font` is CSS shorthand ("48px Inter"), `fontFamily` is a bare family
      // name ("Inter"). `familyFromFont` parses the shorthand and returns null
      // when there is no `<n>px` size token — so for `fontFamily` the value IS
      // already the family. Without the fallback this assertion fails on a
      // definition whose fonts are entirely correct, which is the opposite of
      // what it is for.
      const family = familyFromFont(value) ?? value;
      expect(BUNDLED_FONT_FAMILIES, `${where}.${key} = ${value} is not bundled`).toContain(family);
    }
  });

  it("names only bundled families in DRAW CODE too, not just overlay properties", () => {
    // The assertion above only sees `font` / `fontFamily` properties. Six of
    // the ten draw bodies set a font from a string literal inside JavaScript
    // instead, and one of them does not even use `ctx.font =` — it passes
    // `{ font: "…" }` to a helper. Those literals shipped `Menlo` (macOS-only)
    // on the first extraction: correct on the machine that built the film,
    // a platform fallback for every Windows and Linux user who downloads it.
    //
    // This is written as a CLASS check, not a Menlo check. The allowed set is
    // derived from the registry, so bundling a third family later needs no
    // edit here.
    // Generic CSS keywords are not families; the renderer resolves them to the
    // platform default. Legitimate BEHIND a real family, never in front. The
    // list is imported, not restated — three hand-maintained copies of it drift.
    const allowedFallback = new Set([
      ...BUNDLED_FONT_FAMILIES.map((f) => f.toLowerCase()),
      ...GENERIC_CSS_FAMILIES,
    ]);

    const found: { where: string; font: string; families: string[] }[] = [];
    const scan = (where: string, code: string): void => {
      // One alternative per quote style, not a backreference: the emitted
      // literals are `'500 22px "JetBrains Mono", monospace'` — a single-quoted
      // string containing double quotes, which `(["'`])([^"'`]*)\1` cannot
      // match at all. It would silently skip every font this test exists for.
      for (const m of code.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
        const value = m[1] ?? m[2] ?? m[3] ?? "";
        const parsed = parseFontShorthand(value);
        if (!parsed) continue;
        const families = parsed.family
          .split(",")
          .map((f) => f.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        // Other CSS values parse like a shorthand ("0 0 12px rgba(…)"); only a
        // real family name counts as a font.
        if (!families.length || !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(families[0])) continue;
        found.push({ where, font: value, families });
      }
    };

    for (const o of D.overlays as unknown as Record<string, unknown>[]) {
      if (o.kind === "code") scan(o.id as string, o.drawFunction as string);
    }

    // A silently empty scan would make every assertion below vacuous.
    expect(found.length).toBeGreaterThanOrEqual(20);

    for (const { where, font, families } of found) {
      expect(BUNDLED_FONT_FAMILIES, `${where} asks for ${families[0]} in ${font}`).toContain(
        families[0],
      );
      for (const fallback of families.slice(1)) {
        expect(allowedFallback, `${where} falls back to ${fallback} in ${font}`).toContain(
          fallback.toLowerCase(),
        );
      }
    }
  });
});
