"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useCustomEffects } from "@/lib/queries/effects-catalog";
import {
  effectsRegistryVersion,
  registerCustomEffects,
  subscribeEffectsRegistry,
} from "@/lib/effects/registry";
import { customEffectDefsFromPayload } from "@/lib/effects/hydrate-custom-client";
import { configureEffectSampler } from "@/lib/effects/custom-curves";
import { EffectSampler } from "@/lib/sandbox/effect-sampler";
import { createIframeTransport } from "@/lib/sandbox/iframe-transport";
import { createInOriginTransport } from "@/lib/sandbox/in-origin-transport";
import { readOverlaySandboxMode } from "@/lib/sandbox/mode";

export interface RegisterCustomEffectsResult {
  /** True once the query has resolved (registration has run at least once). */
  ready: boolean;
  /** Number of custom effects registered. */
  count: number;
  /** The set of registered custom effect ids — for the Custom tab filter + per-tile badge. */
  customIds: Set<string>;
}

function effectSandboxMount(): HTMLElement {
  let el = document.getElementById("libi-effect-sandbox-mount");
  if (!el) {
    el = document.createElement("div");
    el.id = "libi-effect-sandbox-mount";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;";
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Register the custom effect packages returned by `GET /api/effects` into the
 * shared client-module registry, so the picker (and compose) see them through
 * `listEffects()`. Mount ONCE high in the tree (PreviewSurface).
 *
 * A custom effect's `animate.js` never runs in this origin: each def reads
 * curves that the effect sandbox — an opaque-origin frame and worker of its
 * own, booted lazily on the first custom effect a frame asks for — samples
 * from the source (lib/effects/custom-curves.ts). The dev-only in-origin mode
 * (LIBI_OVERLAY_SANDBOX=0, lib/sandbox/mode.ts) applies here as it does to
 * code overlays.
 *
 * Registration is keyed off the query DATA identity — React Query returns the
 * same object reference until the payload actually changes — so we never
 * re-register identical data. A version counter bumps so subscribers re-derive
 * after the registry mutates.
 */
export function useRegisterCustomEffects(): RegisterCustomEffectsResult {
  const { data, isSuccess } = useCustomEffects();

  useSyncExternalStore(subscribeEffectsRegistry, effectsRegistryVersion, effectsRegistryVersion);

  const { defs, customIds } = useMemo(() => customEffectDefsFromPayload(data?.custom), [data]);

  useEffect(() => {
    configureEffectSampler(
      () =>
        new EffectSampler({
          createTransport: (nonce) =>
            readOverlaySandboxMode(document) === "in-origin"
              ? createInOriginTransport(nonce)
              : createIframeTransport(effectSandboxMount(), nonce),
        }),
    );
    return () => configureEffectSampler(null);
  }, []);

  useEffect(() => {
    if (!isSuccess) return;
    registerCustomEffects(defs);
  }, [isSuccess, defs]);

  return { ready: isSuccess, count: defs.length, customIds };
}
