"use client";

import { useState } from "react";
import type { Composition, DrawContext } from "@/lib/engine/types";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { compileWithFallback, type LastGood } from "@/lib/preview/last-good";
import { measureCodeContentBox, type ContentBox } from "@/lib/overlays/code-content-fit";

type CompiledFn = (ctx: DrawContext) => void;

interface CompiledResult {
  compiledDrawFns: Record<string, CompiledFn>;
  codeContentBoxes: Record<string, ContentBox | null>;
  errors: Record<string, string>;
}

interface CompileCache {
  /** The composition this cache entry was computed FROM (identity-keyed). */
  composition: Composition | null;
  result: CompiledResult;
  /** overlayId → last successfully-compiled fn (kept when a later edit breaks). */
  lastGood: ReadonlyMap<string, LastGood<CompiledFn>>;
  /** overlayId → { key, box } probe cache (key = code source + rect size). */
  boxCache: ReadonlyMap<string, { key: string; box: ContentBox | null }>;
}

const EMPTY_RESULT: CompiledResult = { compiledDrawFns: {}, codeContentBoxes: {}, errors: {} };

/** Pure recompute: reads the PREVIOUS caches, returns fresh ones (no mutation
 *  of anything that survived from an earlier render). */
function computeCompiled(
  composition: Composition | null,
  prevLastGood: ReadonlyMap<string, LastGood<CompiledFn>>,
  prevBoxCache: ReadonlyMap<string, { key: string; box: ContentBox | null }>,
): Omit<CompileCache, "composition"> {
  const out: Record<string, CompiledFn> = {};
  const boxes: Record<string, ContentBox | null> = {};
  const errs: Record<string, string> = {};
  const lastGood = new Map<string, LastGood<CompiledFn>>();
  const boxCache = new Map<string, { key: string; box: ContentBox | null }>();

  if (!composition) {
    return { result: { compiledDrawFns: out, codeContentBoxes: boxes, errors: errs }, lastGood, boxCache };
  }

  const compile = (src: string): CompiledFn =>
    createDrawFunction(src, DRAW_HELPERS) as unknown as CompiledFn;

  for (const o of composition.overlays ?? []) {
    let src: string | null = null;
    if (o.kind === "code") src = o.drawFunction;
    else if (o.kind === "tracked" && o.content.kind === "code") src = o.content.drawFunction;
    if (src === null) continue;

    const prev = prevLastGood.get(o.id) ?? { value: null, error: null };
    const next = compileWithFallback(src, compile, prev);
    lastGood.set(o.id, next);
    if (next.value) out[o.id] = next.value;
    if (next.error) errs[o.id] = next.error;

    // Probe the content box for PLAIN code overlays only (tracked-code renders
    // through a separate branch with the resolved tracked bbox). Keyed by the
    // source + rect size so a resize / edit re-probes, a refetch does not.
    if (o.kind === "code" && next.value) {
      const key = `${o.rect.width}x${o.rect.height}:${src}`;
      const cached = prevBoxCache.get(o.id);
      if (cached && cached.key === key) {
        boxCache.set(o.id, cached);
        boxes[o.id] = cached.box;
      } else {
        const box = measureCodeContentBox(next.value, o.rect.width, o.rect.height);
        boxCache.set(o.id, { key, box });
        boxes[o.id] = box;
      }
    }
  }

  // Entries for overlays that no longer exist are dropped implicitly: only
  // live overlay ids were copied into the fresh maps above.
  return { result: { compiledDrawFns: out, codeContentBoxes: boxes, errors: errs }, lastGood, boxCache };
}

/**
 * Compiles the `drawFunction` source string of every `code` overlay into
 * a runtime function usable by the renderer. Re-compiles when the
 * composition changes.
 *
 * Also handles tracked overlays whose content.kind === "code" — same
 * compilation path, keyed by overlay.id, sourced from content.drawFunction.
 *
 * Broken code (e.g. the agent saved a syntactically invalid overlay file)
 * does NOT flash blank: the last successfully-compiled fn is retained
 * (`compileWithFallback`) and the error is surfaced in the returned
 * `errors` map so the overlay error badge can render over the rect.
 *
 * For plain `code` overlays it also probes each fn's drawn-ink bbox ONCE per
 * (overlayId, code-source, rect size) — off the hot render path — and returns
 * `codeContentBoxes`, which the renderer uses to contain-fit the content into
 * the overlay rect (a fixed-size graphic fills a resized box; Spin pivots about
 * the content's visual center). Tracked-`code` overlays are NOT probed — their
 * box is the resolved tracked bbox, rendered by a separate branch.
 *
 * Caching: the whole compile result is state keyed on composition identity and
 * recomputed during render when it changes (React's previous-state pattern,
 * self-limiting). Each recompute READS the previous caches and builds fresh
 * ones — nothing that survived an earlier render is mutated, so the render
 * stays pure (the old useMemo + mutable-ref caches read and wrote refs during
 * render, which the hooks rules reject).
 */
export function useOverlayCompiledFns(composition: Composition | null): CompiledResult {
  const [cache, setCache] = useState<CompileCache>({
    composition: null,
    result: EMPTY_RESULT,
    lastGood: new Map(),
    boxCache: new Map(),
  });

  let current = cache;
  if (cache.composition !== composition) {
    current = { composition, ...computeCompiled(composition, cache.lastGood, cache.boxCache) };
    setCache(current);
  }

  return current.result;
}
