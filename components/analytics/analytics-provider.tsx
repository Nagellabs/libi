// components/analytics/analytics-provider.tsx
"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { initAnalytics, trackEvent } from "@/lib/analytics/client";
import {
  makeEngagementTimer,
  normalizePagePath,
  type EngagementTimer,
} from "@/lib/analytics/page-tracking";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ready = useRef(false);
  const timer = useRef<EngagementTimer>(makeEngagementTimer());

  // Init once: fetch identity, init gtag if enabled.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/analytics/identity")
      .then((r) => r.json())
      .then((j: { userId: string; enabled: boolean }) => {
        if (cancelled || !j.enabled) return;
        initAnalytics(j.userId);
        ready.current = true;
        timer.current.enter(normalizePagePath(window.location.pathname), Date.now());
        trackEvent("page_view", { page_path: normalizePagePath(window.location.pathname) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // On route change: flush previous page's engagement, log new page_view.
  useEffect(() => {
    if (!ready.current) return;
    const path = normalizePagePath(pathname);
    const left = timer.current.leave(Date.now());
    if (left) trackEvent("page_engagement", left);
    timer.current.enter(path, Date.now());
    trackEvent("page_view", { page_path: path });
  }, [pathname]);

  // Flush engagement when the tab is hidden / closed.
  useEffect(() => {
    const flush = () => {
      const left = timer.current.leave(Date.now());
      if (left) trackEvent("page_engagement", left);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return <>{children}</>;
}
