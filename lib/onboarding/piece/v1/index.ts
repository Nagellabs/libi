// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// from the real `libi-onboarding` piece.
//
// THE FILM RUNS 52.0 SECONDS. Its 6 background layers cover
// only the first 30.0, and the difference is not slack:
// `getCompositionFrames` is the latest overlay or audio end, and the
// finale runs on top of full-frame video and the end card, with 7
// overlays deliberately holding to the last frame so the card stays on
// screen long enough to read. Shorten one of those durations and the film
// gets shorter with nothing else failing.
//
// THERE ARE NO SCENES. The six beats were canvas scenes in the piece this
// was first extracted from; a scene had no startTime, rect, z or opacity,
// so the six layers a user most wants to nudge were the only ones the
// editor could not move. They are full-frame `code` overlays at z 0 now,
// laid end to end, and the canvas-scene layer is gone from the product.
//
// Keyframe `t` values are normalized 0→1 of their own overlay's duration.
// They were rescaled by hand when the end card grew from 1.4 s to 11.4 s so
// the animations kept their real-time pacing and then hold at `t: 1`. They
// are odd-looking on purpose — do not round or re-normalize them.
//
// Overlay order is the PIECE's order, not sorted. `overlaysActiveAt` sorts
// by `z` with a stable sort, and 24 pairs of overlays here share a
// `z` and overlap in time — array order is their stacking tiebreak.
// Sorting for readability would restack the end card.
//
// Media is named by slug, never by fileId, and per-overlay `version`
// counters are dropped: both are per-install bookkeeping that means
// nothing on the machine that downloads this.
//
// FONTS DIVERGE FROM THE SOURCE PIECE, deliberately. The piece asks for
// `Helvetica Neue` and `Menlo` — both macOS-only — in overlay properties
// (7 of them) and in overlay draw code (12). Every one is
// mapped to a family libi bundles, so the film renders identically on
// Windows and Linux instead of falling through to whatever face the
// platform picks. The source piece is left untouched; if you diff the two
// and see different font strings, THAT IS THE POINT. Each substitution is
// listed in the file it applies to and logged under op `font-substituted`
// / `font-in-code`.
//
// SLOT D SHIPS NO OBJECT TRACK, also deliberately. The source piece draws
// its green reticle with a `tracked` overlay (`tracked-c5da91a2`) over a real
// track. Here it is the plain `code` overlay `code-c5da91a2`, drawing the
// identical reticle from that track's boxes baked into its draw function —
// object tracking provisions a local model on first use that a brand-new
// user has not installed, and a live tracked overlay would put tracking
// controls in their inspector for a track they cannot regenerate. `tracks`
// is therefore not a field of this definition at all — see the "Slot D"
// section of scripts/extract-onboarding-piece.ts.
//
// ON-SCREEN STRINGS the piece got wrong about libi are corrected on the
// way out, listed in the file each applies to and logged under op
// `text-corrected`:
//   code-558ob5uw: "method sot" -> "method botsort"
//   code-558ob5uw: "engine yoloe+botsort" -> "engine yoloe"
import type { OnboardingPieceDefinition } from "../types";
import { CODE_T8JWCDP3_DRAW } from "./overlay-code/code-t8jwcdp3";
import { CODE_P7KVFTUJ_DRAW } from "./overlay-code/code-p7kvftuj";
import { CODE_5JLS8N94_DRAW } from "./overlay-code/code-5jls8n94";
import { CODE_558OB5UW_DRAW } from "./overlay-code/code-558ob5uw";
import { CODE_SN2LI53L_DRAW } from "./overlay-code/code-sn2li53l";
import { CODE_MRYIM9R3_DRAW } from "./overlay-code/code-mryim9r3";
import { CODE_T9HX2CB7_DRAW } from "./overlay-code/code-t9hx2cb7";
import { CODE_C5DA91A2_DRAW } from "./overlay-code/code-c5da91a2";
import { CODE_89F4SLUC_DRAW } from "./overlay-code/code-89f4sluc";
import { CODE_N4YQ9KV5_DRAW } from "./overlay-code/code-n4yq9kv5";

export const ONBOARDING_PIECE_V1: OnboardingPieceDefinition = {
  version: "v1",
  name: "Welcome to libi",
  width: 1920,
  height: 1080,
  fps: 30,
  beats: [
    { name: "SLOT A — chat: type the prompt", startTime: 0, duration: 4 },
    { name: "SLOT B — agent builds (montage)", startTime: 4, duration: 6 },
    { name: "SLOT C — generation + bg removal", startTime: 10, duration: 6 },
    { name: "SLOT D — tracking + code overlay", startTime: 16, duration: 8 },
    { name: "SLOT E — human editing", startTime: 24, duration: 2.5 },
    { name: "SLOT F — export", startTime: 26.5, duration: 3.5 },
  ],
  overlays: [
    {
      id: "code-t8jwcdp3",
      kind: "code",
      displayName: "SLOT A — chat: type the prompt",
      startTime: 0,
      duration: 4,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_T8JWCDP3_DRAW,
    },
    {
      id: "code-p7kvftuj",
      kind: "code",
      displayName: "SLOT B — agent builds (montage)",
      startTime: 4,
      duration: 6,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_P7KVFTUJ_DRAW,
    },
    {
      id: "code-5jls8n94",
      kind: "code",
      displayName: "SLOT C — generation + bg removal",
      startTime: 10,
      duration: 6,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_5JLS8N94_DRAW,
    },
    {
      id: "code-558ob5uw",
      kind: "code",
      displayName: "SLOT D — tracking + code overlay",
      startTime: 16,
      duration: 8,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_558OB5UW_DRAW,
    },
    {
      id: "code-sn2li53l",
      kind: "code",
      displayName: "SLOT E — human editing",
      startTime: 24,
      duration: 2.5,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_SN2LI53L_DRAW,
    },
    {
      id: "code-mryim9r3",
      kind: "code",
      displayName: "SLOT F — export",
      startTime: 26.5,
      duration: 3.5,
      z: 0,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      opacity: 1,
      drawFunction: CODE_MRYIM9R3_DRAW,
    },
    {
      id: "vid-so51lufn",
      kind: "video",
      startTime: 34.4,
      duration: 6,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 5,
      opacity: 1,
      assetSlug: "clip-water-impact.mp4",
      trim: { start: 0, end: 6 },
      fit: "cover",
      group: "inner-film",
    },
    {
      id: "text-viwsnz4r",
      kind: "text",
      startTime: 37.7,
      duration: 1.8,
      rect: { x: 260, y: 620, width: 1400, height: 120 },
      z: 10,
      opacity: 1,
      content: "ZEPHYRON ONE",
      font: "48px Inter",
      color: "#ffffff",
      align: "center",
      fontFamily: "Inter",
      fontSize: 90,
      fontWeight: 800,
      shadow: { color: "rgba(232,121,249,0.75)", blur: 60, dx: 0, dy: 0 },
      group: "inner-film",
      effects: {
        in: { effectId: "pop" },
      },
      stroke: { color: "rgba(34,211,238,0.9)", width: 2 },
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 304, y: 441.6, width: 1312, height: 196.79999999999998 },
              easing: "ease-out",
            },
            {
              t: 0.2222222222222222,
              value: { x: 144, y: 417.6, width: 1632, height: 244.8 },
              easing: "linear",
            },
            {
              t: 1,
              value: { x: 63.999999999999886, y: 405.6, width: 1792.0000000000002, height: 268.8 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.2222222222222222, value: 1, easing: "linear" },
            { t: 1, value: 1 },
          ],
        },
      },
    },
    {
      id: "code-t9hx2cb7",
      kind: "code",
      startTime: 39.5,
      duration: 12.5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 20,
      opacity: 1,
      drawFunction: CODE_T9HX2CB7_DRAW,
      displayName: "End card backdrop",
    },
    {
      id: "text-pfxly74z",
      kind: "text",
      startTime: 39.8,
      duration: 12.2,
      rect: { x: 950, y: 300, width: 400, height: 220 },
      z: 21,
      opacity: 1,
      content: "libi",
      font: "48px Inter",
      color: "#6B8A6B",
      align: "left",
      fontFamily: "Inter",
      fontSize: 170,
      fontWeight: 700,
      group: "end-card",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 950, y: 300, width: 400, height: 220 },
              easing: "ease-out",
            },
            {
              t: 0.062842,
              value: { x: 950, y: 300, width: 400, height: 220 },
              easing: "linear",
            },
            {
              t: 0.180328,
              value: { x: 942, y: 295.6, width: 416, height: 228.8 },
              easing: "linear",
            },
            {
              t: 1,
              value: { x: 942, y: 295.6, width: 416, height: 228.8 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.062842, value: 1, easing: "linear" },
            { t: 0.180328, value: 1, easing: "linear" },
            { t: 1, value: 1 },
          ],
        },
      },
      shadow: { color: "rgba(139,180,139,0.55)", blur: 70, dx: 0, dy: 0 },
    },
    {
      id: "text-cpih0big",
      kind: "text",
      startTime: 40.6,
      duration: 11.4,
      rect: { x: 360, y: 610, width: 1200, height: 80 },
      z: 21,
      opacity: 1,
      content: "Your best AI video studio",
      font: "48px Inter",
      color: "#9aa3b2",
      align: "center",
      fontFamily: "Inter",
      fontSize: 46,
      fontWeight: 400,
      reveal: { mode: "fade-words", durationMs: 500 },
      group: "end-card",
    },
    {
      id: "text-k33u26lz",
      kind: "text",
      startTime: 40.8,
      duration: 11.2,
      rect: { x: 450, y: 745, width: 520, height: 80 },
      z: 21,
      opacity: 1,
      content: "npx @nagellabs/libi",
      font: "48px Inter",
      color: "#8ef0c0",
      align: "center",
      fontFamily: "JetBrains Mono",
      fontSize: 42,
      fontWeight: 400,
      background: { color: "rgba(255,255,255,0.06)", padding: 18, radius: 12 },
      reveal: { mode: "typewriter", durationMs: 900 },
      group: "end-card",
    },
    {
      id: "vid-gdgll882",
      kind: "video",
      startTime: 30,
      duration: 4.4,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 5,
      opacity: 1,
      assetSlug: "clip-hero-orbit-v2.mp4",
      trim: { start: 0, end: 4.4 },
      fit: "cover",
      group: "inner-film",
    },
    {
      id: "img-f8wp3xa7",
      kind: "image",
      startTime: 12.7,
      duration: 3.3,
      rect: { x: 152, y: 342, width: 356, height: 200 },
      z: 8,
      opacity: 1,
      assetSlug: "kf-hero-start.png",
      group: "kf-panels",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 152, y: 372, width: 356, height: 200 },
              easing: "ease-out",
            },
            {
              t: 0.1111111111111111,
              value: { x: 152, y: 342, width: 356, height: 200 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.1111111111111111, value: 1 },
          ],
        },
      },
    },
    {
      id: "img-o4d04n66",
      kind: "image",
      startTime: 13.15,
      duration: 2.85,
      rect: { x: 572, y: 342, width: 356, height: 200 },
      z: 8,
      opacity: 1,
      assetSlug: "kf-hero-end.png",
      group: "kf-panels",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 572, y: 372, width: 356, height: 200 },
              easing: "ease-out",
            },
            {
              t: 0.1286549707602339,
              value: { x: 572, y: 342, width: 356, height: 200 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.1286549707602339, value: 1 },
          ],
        },
      },
    },
    {
      id: "img-frpfz5sl",
      kind: "image",
      startTime: 13.6,
      duration: 2.4,
      rect: { x: 992, y: 342, width: 356, height: 200 },
      z: 8,
      opacity: 1,
      assetSlug: "kf-water-start.png",
      group: "kf-panels",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 992, y: 372, width: 356, height: 200 },
              easing: "ease-out",
            },
            {
              t: 0.1527777777777778,
              value: { x: 992, y: 342, width: 356, height: 200 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.1527777777777778, value: 1 },
          ],
        },
      },
    },
    {
      id: "img-1rxvfk6s",
      kind: "image",
      startTime: 14.05,
      duration: 1.95,
      rect: { x: 1412, y: 342, width: 356, height: 200 },
      z: 8,
      opacity: 1,
      assetSlug: "kf-water-end.png",
      group: "kf-panels",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 1412, y: 372, width: 356, height: 200 },
              easing: "ease-out",
            },
            {
              t: 0.18803418803418803,
              value: { x: 1412, y: 342, width: 356, height: 200 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.18803418803418803, value: 1 },
          ],
        },
      },
    },
    {
      id: "vid-lu4jxr6v",
      kind: "video",
      startTime: 16,
      duration: 6,
      rect: { x: 320, y: 150, width: 1280, height: 720 },
      z: 4,
      opacity: 1,
      assetSlug: "clip-track-demo.mp4",
      trim: { start: 0, end: 6 },
      fit: "cover",
      group: "slot-d",
    },
    {
      id: "code-c5da91a2",
      kind: "code",
      startTime: 17.5,
      duration: 4.5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 6,
      opacity: 1,
      drawFunction: CODE_C5DA91A2_DRAW,
    },
    {
      id: "code-89f4sluc",
      kind: "code",
      startTime: 16,
      duration: 1.4,
      rect: { x: 320, y: 150, width: 1280, height: 720 },
      z: 6,
      opacity: 1,
      drawFunction: CODE_89F4SLUC_DRAW,
      displayName: "Scan — searching for target",
    },
    {
      id: "code-n4yq9kv5",
      kind: "code",
      startTime: 37.3,
      duration: 2.2,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 9,
      opacity: 1,
      drawFunction: CODE_N4YQ9KV5_DRAW,
      displayName: "Ad end vignette",
    },
    {
      id: "img-zyv32z0t",
      kind: "image",
      startTime: 37.4,
      duration: 2.1,
      rect: { x: 820, y: 140, width: 280, height: 280 },
      z: 10,
      opacity: 1,
      assetSlug: "logo-mark.png",
      group: "shoe-brand",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 869.25, y: 309.25, width: 181.50000000000003, height: 181.50000000000003 },
              easing: "ease-out",
            },
            {
              t: 0.2222222222222222,
              value: { x: 795, y: 235, width: 330, height: 330 },
              easing: "linear",
            },
            {
              t: 0.3492063492063492,
              value: { x: 785.4497891718671, y: 98.38367346938782, width: 333.2326530612245, height: 333.2326530612245 },
            },
            {
              t: 1,
              value: { x: 820, y: 140, width: 280, height: 280 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.2222222222222222, value: 1, easing: "linear" },
            { t: 1, value: 1 },
          ],
        },
      },
    },
    {
      id: "text-hlcq7y7c",
      kind: "text",
      startTime: 38.1,
      duration: 1.4,
      rect: { x: 460, y: 775, width: 1000, height: 55 },
      z: 10,
      opacity: 1,
      content: "ENGINEERED TO FLOAT",
      font: "48px Inter",
      color: "#9aa3b2",
      align: "center",
      fontFamily: "Inter",
      fontSize: 32,
      fontWeight: 500,
      reveal: { mode: "fade-words", durationMs: 500 },
      group: "shoe-brand",
    },
    {
      id: "text-16gcy19w",
      kind: "text",
      startTime: 40.8,
      duration: 11.2,
      rect: { x: 1010, y: 745, width: 460, height: 80 },
      z: 21,
      opacity: 1,
      content: "Or download for Mac",
      font: "48px Inter",
      color: "#cdd3de",
      align: "center",
      fontFamily: "Inter",
      fontSize: 42,
      fontWeight: 500,
      background: { color: "rgba(255,255,255,0.08)", padding: 18, radius: 12 },
      reveal: { mode: "fade-words", durationMs: 300 },
      group: "end-card",
    },
    {
      id: "img-vxnkonqd",
      kind: "image",
      startTime: 39.8,
      duration: 12.2,
      rect: { x: 670, y: 228, width: 320, height: 320 },
      z: 21,
      opacity: 1,
      assetSlug: "libi-ring-glyph.png",
      group: "end-card",
      keyframes: {
        rect: {
          keyframes: [
            {
              t: 0,
              value: { x: 670, y: 228, width: 320, height: 320 },
              easing: "ease-out",
            },
            {
              t: 0.062842,
              value: { x: 670, y: 228, width: 320, height: 320 },
              easing: "linear",
            },
            {
              t: 0.180328,
              value: { x: 663.6, y: 221.6, width: 332.8, height: 332.8 },
              easing: "linear",
            },
            {
              t: 1,
              value: { x: 663.6, y: 221.6, width: 332.8, height: 332.8 },
            },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0, easing: "ease-out" },
            { t: 0.062842, value: 1, easing: "linear" },
            { t: 0.180328, value: 1, easing: "linear" },
            { t: 1, value: 1 },
          ],
        },
      },
      shadow: { color: "rgba(139,180,139,0.55)", blur: 70, dx: 0, dy: 0 },
    },
    {
      id: "text-3048dja6",
      kind: "text",
      startTime: 41.2,
      duration: 10.8,
      rect: { x: 610, y: 872, width: 700, height: 64 },
      z: 21,
      opacity: 1,
      content: "libi.nagellabs.com",
      font: "48px Inter",
      color: "#8b93a7",
      align: "center",
      fontFamily: "Inter",
      fontSize: 40,
      fontWeight: 400,
      reveal: { mode: "fade-words", durationMs: 300 },
      group: "end-card",
    },
  ],
  audioClips: [
    {
      id: "clip_i13f0m0n",
      kind: "inline",
      assetSlug: "clip-water-impact.mp4",
      startTime: 34.4,
      duration: 6,
      trimStart: 0,
      volume: 0.6,
      enabled: true,
      linkedOverlayId: "vid-so51lufn",
      label: "film audio — splash",
    },
    {
      id: "clip_4t921f5s",
      kind: "standalone",
      assetSlug: "music-build-28s.mp3",
      startTime: 0,
      duration: 28,
      trimStart: 0,
      volume: 0.85,
      enabled: true,
      label: "music — build (hard cut at 0:28)",
      duck: {
        sidechainClipIds: ["clip_vo1", "clip_vo2", "clip_vo3", "clip_vo4", "clip_vo5", "clip_vo6"],
        thresholdDb: -30,
        ratio: 4,
        attackMs: 50,
        releaseMs: 250,
        reductionDb: -12,
      },
    },
    {
      id: "clip_g0uxbvkf",
      kind: "standalone",
      assetSlug: "sfx-typing.mp3",
      startTime: 0.2,
      duration: 3.6,
      trimStart: 0,
      volume: 0.5,
      enabled: true,
      label: "SFX typing",
    },
    {
      id: "clip_pj7r0it5",
      kind: "standalone",
      assetSlug: "sfx-basshit.mp3",
      startTime: 3.95,
      duration: 1,
      trimStart: 0,
      volume: 0.9,
      enabled: true,
      label: "SFX bass hit (Enter)",
    },
    {
      id: "clip_316hr7uq",
      kind: "standalone",
      assetSlug: "sfx-clicks.mp3",
      startTime: 4.6,
      duration: 4,
      trimStart: 0,
      volume: 0.35,
      enabled: true,
      label: "SFX UI clicks",
    },
    {
      id: "clip_wuk6rzqz",
      kind: "standalone",
      assetSlug: "sfx-riser.mp3",
      startTime: 24,
      duration: 4,
      trimStart: 0,
      volume: 0.7,
      enabled: true,
      label: "SFX riser → cut",
    },
    {
      id: "clip_v4tmovmb",
      kind: "inline",
      assetSlug: "clip-hero-orbit-v2.mp4",
      startTime: 30,
      duration: 4.4,
      trimStart: 0,
      volume: 0.6,
      enabled: true,
      linkedOverlayId: "vid-gdgll882",
      label: "film audio — orbit",
    },
    {
      id: "clip_c44rnjt8",
      kind: "standalone",
      assetSlug: "music-anthem-12s.mp3",
      startTime: 30,
      duration: 12,
      trimStart: 0,
      volume: 0.9,
      enabled: true,
      label: "music — anthem (0:30–0:42)",
      duck: {
        sidechainClipIds: ["clip_vo1", "clip_vo2", "clip_vo3", "clip_vo4", "clip_vo5", "clip_vo6"],
        thresholdDb: -30,
        ratio: 4,
        attackMs: 50,
        releaseMs: 250,
        reductionDb: -12,
      },
    },
    {
      id: "clip_tnqhriva",
      kind: "inline",
      assetSlug: "clip-track-demo.mp4",
      startTime: 16,
      duration: 6,
      trimStart: 0,
      volume: 1,
      enabled: false,
      linkedOverlayId: "vid-lu4jxr6v",
      label: "tracking clip audio (muted)",
    },
    {
      id: "clip_vo1",
      kind: "standalone",
      assetSlug: "vo-1-describe.mp3",
      startTime: 1,
      duration: 1.149,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 1 — You describe it.",
    },
    {
      id: "clip_vo2",
      kind: "standalone",
      assetSlug: "vo-2-agent.mp3",
      startTime: 5,
      duration: 2.273,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 2 — A coding agent builds it.",
    },
    {
      id: "clip_vo3",
      kind: "standalone",
      assetSlug: "vo-3-generates.mp3",
      startTime: 11,
      duration: 3.474,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 3 — It generates the footage…",
    },
    {
      id: "clip_vo4",
      kind: "standalone",
      assetSlug: "vo-4-code.mp3",
      startTime: 17,
      duration: 2.508,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 4 — Every frame is code.",
    },
    {
      id: "clip_vo5",
      kind: "standalone",
      assetSlug: "vo-5-director.mp3",
      startTime: 24.6,
      duration: 1.411,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 5 — You stay the director.",
    },
    {
      id: "clip_vo6",
      kind: "standalone",
      assetSlug: "vo-6-madein.mp3",
      startTime: 37.3,
      duration: 2.508,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "VO 6 — This video? Made in libi.",
    },
  ],
};
