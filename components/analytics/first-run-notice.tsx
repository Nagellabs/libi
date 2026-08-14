"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/** Shows a one-time, dismissible disclosure that anonymous analytics are on. */
export function FirstRunNotice() {
  useEffect(() => {
    let cancelled = false;
    fetch("/api/analytics/notice-seen")
      .then((r) => r.json())
      .then((j: { shown: boolean }) => {
        if (cancelled || j.shown) return;
        toast("libi collects anonymous usage analytics to improve the app.", {
          description: "No personal data is collected. Manage this in Settings → Privacy.",
          duration: 12000,
          action: { label: "Got it", onClick: () => {} },
        });
        void fetch("/api/analytics/notice-seen", { method: "POST" });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
