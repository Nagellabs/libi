"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useCustomEffects } from "@/lib/queries/effects-catalog";
import {
  effectsRegistryVersion,
  registerCustomEffects,
  subscribeEffectsRegistry,
} from "@/lib/effects/registry";
import { compileCustomPayload } from "@/lib/effects/hydrate-custom-client";

export interface RegisterCustomEffectsResult {
  /** True once the query has resolved (registration has run at least once). */
  ready: boolean;
  /** Number of custom effects successfully compiled + registered. */
  count: number;
  /** The set of registered custom effect ids — for the Custom tab filter + per-tile badge. */
  customIds: Set<string>;
}

/**
 * Compile the custom effect packages returned by `GET /api/effects` and register
 * them into the shared client-module registry, so the picker (and compose) see
 * them through `listEffects()`. Mount ONCE high in the tree (PreviewSurface).
 *
 * Registration is keyed off the query DATA identity — React Query returns the
 * same object reference until the payload actually changes — so we never
 * re-register identical data. A version counter bumps so subscribers re-derive
 * after the registry mutates.
 */
export function useRegisterCustomEffects(): RegisterCustomEffectsResult {
  const { data, isSuccess } = useCustomEffects();

  // Subscribe to the registry itself: when the effect below registers a new
  // set post-commit, the registry notifies and this host re-renders, so
  // consumers reading through listEffects() re-derive. (Replaces the old
  // setState-in-effect version bump with the external-store idiom.)
  useSyncExternalStore(subscribeEffectsRegistry, effectsRegistryVersion, effectsRegistryVersion);

  // Compile only when the payload reference changes (React Query data identity).
  const { defs, customIds } = useMemo(() => compileCustomPayload(data?.custom), [data]);

  useEffect(() => {
    if (!isSuccess) return;
    registerCustomEffects(defs);
  }, [isSuccess, defs]);

  return { ready: isSuccess, count: defs.length, customIds };
}
