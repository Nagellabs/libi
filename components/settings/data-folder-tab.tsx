"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

export function DataFolderTab() {
  const [currentPath, setCurrentPath] = useState<string>("~/.libi");
  const [customPath, setCustomPath] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/data-folder")
      .then((r) => r.json())
      .then((data) => {
        setCurrentPath(data.path);
        setCustomPath(data.customPath || "");
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    await fetch("/api/settings/data-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: customPath || null }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Libi Home</h3>
        <p className="text-sm text-muted-foreground">
          Libi Home stores all your data — database, media files, skills,
          memories, and logs. Agents launched anywhere share this one home.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Current location</label>
        <div className="rounded-md bg-muted px-3 py-2 text-sm font-mono">
          {currentPath}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Custom path (optional)</label>
        <input
          type="text"
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          placeholder="Leave empty to use default (~/.libi)"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Changing this path does not move existing data. Move the folder
          manually first. Requires app restart to take effect.
        </p>
      </div>

      <Button onClick={handleSave} className="cursor-pointer">
        {saved ? "Saved!" : "Save"}
      </Button>
    </div>
  );
}
