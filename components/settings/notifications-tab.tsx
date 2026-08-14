"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

interface NotificationsSetting {
  backgroundJobComplete: boolean;
}

export function NotificationsTab() {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    fetch("/api/settings/notifications")
      .then((r) => r.json())
      .then((j: NotificationsSetting) => setEnabled(j.backgroundJobComplete))
      .catch(() => {
        // Keep default ON; loading complete
      })
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundJobComplete: next }),
      });
      if (!res.ok) {
        throw new Error(`PUT failed with status ${res.status}`);
      }
    } catch {
      // Revert to the value before this toggle.
      setEnabled(!next);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64 mt-2" />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-80" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <Skeleton className="h-6 w-11 rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose when libi notifies you about background work.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="notif-bgcomplete" className="font-medium">
            Notify me when long jobs finish in the background
          </Label>
          <p className="text-sm text-muted-foreground mt-1">
            A system notification fires when the libi window isn&apos;t focused
            and a long-running job (music generation, model downloads, tracking,
            etc.) takes longer than 10 seconds. Click the notification to bring
            libi to the front.
          </p>
        </div>
        <Switch
          id="notif-bgcomplete"
          checked={enabled}
          onCheckedChange={toggle}
          className="cursor-pointer"
        />
      </div>
    </div>
  );
}
