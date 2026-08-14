// @vitest-environment jsdom
/**
 * Registry ↔ rendered field coverage parity — intent-group (exact-group) model.
 *
 * For each overlay kind that has a composed inspector, and for EACH group in
 * `groupsForKind(kind)`, mount the composed `OverlayInspectorBody` at that group
 * and collect every `[data-field]`. Then assert:
 *
 *   (a) per-tab parity — the collected keys equal `fieldKeysForKindGroup(kind, group)`
 *       PLUS any documented MIRROR keys placed on that tab (see MIRRORS);
 *   (b) union parity — the union over all groups equals `fieldKeysForKind(kind)`
 *       (mirrors don't add new keys — they re-show an existing key);
 *   (c) disjointness — no NON-mirror key appears in two groups.
 *
 * A MIRROR is a field deliberately re-shown on a second tab bound to the SAME
 * model field (e.g. the caption Size control under BOTH Transform and Text,
 * both driving `fontSize`). Its registry home stays a single group; the mirror
 * tab is whitelisted here.
 *
 * This FAILS the moment someone adds, removes, regroups, or moves an inspector
 * field across tabs (other than a whitelisted mirror) without updating
 * `lib/overlays/inspector-fields.ts`.
 */
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The composed inspector body now mounts <EffectsInspector>, which calls the
// effects mutation hooks. Mock them so the parity render needs no QueryClient.
vi.mock("@/lib/queries/effects", () => ({
  useApplyLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearReveal: () => ({ mutate: vi.fn(), isPending: false }),
}));

// OverlayInspectorBody now reads caption styles via React Query — stub it so the
// inspector renders without a QueryClientProvider (falls back to bundled styles).
vi.mock("@/lib/queries/caption-styles", () => ({
  useCaptionStyles: () => ({ data: undefined }),
}));

// The text inspector's Style row now mounts <PresetRow>, which calls the
// overlay-preset query hooks. Mock them so the parity render needs no QueryClient.
vi.mock("@/lib/queries/overlay-presets", () => ({
  useOverlayPresets: () => ({ data: [], isLoading: false }),
  useApplyPreset: () => ({ mutate: vi.fn() }),
  useSavePreset: () => ({ mutate: vi.fn() }),
  useDeletePreset: () => ({ mutate: vi.fn() }),
}));

// The transform/3D field groups read `setGizmoMode` from the editor-state context
// to auto-switch the canvas gizmo. Stub the hook so they render without a provider.
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ setGizmoMode: vi.fn() }),
}));

// The tracked Anchors tab reads the track (manual-anchor list) + its action
// handlers via React Query hooks. Mock them so the parity render needs no
// QueryClient — an undefined track renders the empty panel, and the
// `data-field="trackAnchors"` marker is unconditional.
vi.mock("@/lib/queries/tracks", () => ({
  trackKeys: { detail: (id: string) => ["track", id] as const },
  useTrack: () => ({ data: undefined }),
  useTrackAnchorActions: () => ({ applyDeletes: vi.fn(), retrack: vi.fn() }),
}));

import { OverlayInspectorBody } from "@/components/preview/layers-inspector-panel";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import {
  groupsForKind,
  fieldKeysForKind,
  fieldKeysForKindGroup,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";
import type {
  CodeOverlay,
  ImageOverlay,
  Overlay,
  TextOverlay,
  ThreeOverlay,
  VideoOverlay,
} from "@/lib/engine/types";

afterEach(() => cleanup());

/**
 * Documented mirror keys: a key re-shown on a tab OTHER than its registry home.
 * Keyed by kind → the group the mirror renders on → keys. The mirror's registry
 * home group is unchanged; the coverage check whitelists the mirror tab.
 */
const MIRRORS: Partial<Record<InspectorOverlayKind, Partial<Record<InspectorGroup, string[]>>>> = {
  // (No mirrors today. The caption Size control used to be mirrored on Transform
  // while homed under Text; it now lives ONLY on Transform — registry home
  // `fontSize` → transform — so there's no duplicate to whitelist.)
};

function mirrorsFor(kind: InspectorOverlayKind, group: InspectorGroup): string[] {
  return MIRRORS[kind]?.[group] ?? [];
}

const baseRect = { x: 0, y: 0, width: 100, height: 50 };

function makeTextOverlay(): TextOverlay {
  return {
    id: "t1",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
    // background + stroke + shadow ON so their detail fields mount; reveal in
    // typewriter mode so reveal fields render.
    background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 },
    stroke: { color: "#000000", width: 6 },
    shadow: { color: "rgba(0,0,0,0.7)", blur: 8 },
    reveal: { mode: "typewriter", fraction: 0.6 },
    // 3D extrusion ON so the 3D-group geometry/color/lighting fields mount (the
    // 3D-tab geometry block is gated on threeD being present).
    threeD: { depth: 20 },
  };
}

function makeThreeOverlay(): ThreeOverlay {
  return {
    id: "th1",
    kind: "three",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    sceneFunction: "// scene",
    cameraPreset: "billboard",
  };
}

function makeImageOverlay(): ImageOverlay {
  return {
    id: "i1",
    kind: "image",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    fileId: "f1",
  };
}

function makeVideoOverlay(): VideoOverlay {
  return {
    id: "v1",
    kind: "video",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    fileId: "f1",
  };
}

function makeCodeOverlay(): CodeOverlay {
  return {
    id: "c1",
    kind: "code",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    drawFunction: "// draw",
  };
}

function makeTrackedOverlay(): Overlay {
  return {
    id: "tr1",
    kind: "tracked",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { ...baseRect },
    opacity: 1,
    trackId: "trk-1",
    content: { kind: "emoji", char: "⬇" },
    fit: "tight",
    scale: 1,
    smoothing: "linear",
  } as unknown as Overlay;
}

const FIXTURES: Record<
  Extract<InspectorOverlayKind, "text" | "three" | "image" | "video" | "code" | "tracked">,
  () => Overlay
> = {
  text: makeTextOverlay,
  three: makeThreeOverlay,
  image: makeImageOverlay,
  video: makeVideoOverlay,
  code: makeCodeOverlay,
  tracked: makeTrackedOverlay,
};

function renderBody(overlay: Overlay, group: InspectorGroup) {
  render(
    createElement(OverlayInspectorBody, {
      overlay,
      mode: group,
      onCommit: vi.fn(),
      pieceId: "p1",
      effectHighlightStore: createEffectHighlightStore(),
      onOpenEffects: vi.fn(),
      effectsReadOnly: false,
    }),
  );
}

function renderedDataFields(): string[] {
  return Array.from(document.querySelectorAll("[data-field]")).map(
    (el) => el.getAttribute("data-field")!,
  );
}

describe("inspector-fields registry ↔ rendered parity (intent-group tabs)", () => {
  for (const [kind, makeOverlay] of Object.entries(FIXTURES) as [
    keyof typeof FIXTURES,
    () => Overlay,
  ][]) {
    describe(`${kind} overlay`, () => {
      const groups = groupsForKind(kind);

      // (a) per-tab parity, for each available group (registry keys + mirrors).
      for (const group of groups) {
        it(`renders exactly the ${group}-group fields`, () => {
          renderBody(makeOverlay(), group);
          const rendered = new Set(renderedDataFields());
          const expected = new Set([
            ...fieldKeysForKindGroup(kind, group),
            ...mirrorsFor(kind, group),
          ]);
          expect([...rendered].sort()).toEqual([...expected].sort());
        });
      }

      // (b) union parity + (c) disjointness across tabs (mirrors excepted).
      it("union over tabs == fieldKeysForKind, with no non-mirror key on two tabs", () => {
        const union = new Set<string>();
        const seen = new Map<string, InspectorGroup>();
        for (const group of groups) {
          cleanup();
          renderBody(makeOverlay(), group);
          const mirrors = new Set(mirrorsFor(kind, group));
          for (const key of renderedDataFields()) {
            if (!mirrors.has(key) && seen.has(key)) {
              // (c) a non-mirror key must not appear in two groups.
              expect(
                false,
                `field "${key}" rendered in both ${seen.get(key)} and ${group} for kind ${kind}`,
              ).toBe(true);
            }
            if (!mirrors.has(key)) seen.set(key, group);
            union.add(key);
          }
        }
        const all = new Set(fieldKeysForKind(kind));
        expect([...union].sort()).toEqual([...all].sort());
      });
    });
  }
});
