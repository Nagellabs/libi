"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { UseQueryResult } from "@tanstack/react-query";
import { firstLaunchHref } from "@/lib/onboarding/return-to";
import { readHasFailed, useOnboardingState, type OnboardingState } from "@/lib/queries/onboarding";

type GateRoute = "first-launch" | "editor";

/**
 * Where the onboarding state sends this page, or null while it isn't known. A
 * state that could not be read is a returning user: the first failed request
 * shows the editor, rather than holding it on its skeleton through React Query's
 * retries, which go on in the background (`readHasFailed`).
 */
function gateRoute(onboarding: UseQueryResult<OnboardingState>): GateRoute | null {
  if (onboarding.data) return onboarding.data.needsPersona ? "first-launch" : "editor";
  return readHasFailed(onboarding) ? "editor" : null;
}

/**
 * A first launch belongs on the Agents tab, with the persona question on top of
 * it. Until the onboarding state says whether this is one, only `fallback`
 * paints; when it is one, the route is replaced before `children` ever render —
 * so the user never sees the editor flash up and then switch away. A deep link
 * (`/editor?piece=…`) is carried along, and the question sends the user back to
 * it once answered. Anyone who has already answered gets `children` as before,
 * and so does a state that could not be read: onboarding never locks anyone out.
 *
 * The first route decided is kept for as long as the gate is mounted: a retry
 * that answers late never pulls a user out of the editor they are already in.
 */
export function FirstLaunchGate({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const router = useRouter();
  const onboarding = useOnboardingState();
  const [decided, setDecided] = useState<GateRoute | null>(null);
  const route = decided ?? gateRoute(onboarding);
  // Kept the moment it is known, during this render (React's previous-state pattern).
  if (decided === null && route !== null) setDecided(route);

  useEffect(() => {
    if (decided === "first-launch") router.replace(firstLaunchHref(window.location));
  }, [decided, router]);

  if (route === "editor") return <>{children}</>;
  return <>{fallback}</>;
}
