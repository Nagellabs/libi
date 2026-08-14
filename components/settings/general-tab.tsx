"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UpdatesSection } from "@/components/settings/updates-section";
import { useEditorState } from "@/lib/editor-state-context";

const LIBI_PREFIXES = ["libi:", "libi-"];
const OTHER_KEYS = ["theme"];

function resetLocalPreferences(): number {
  let cleared = 0;
  const toRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      LIBI_PREFIXES.some((p) => key.startsWith(p)) ||
      OTHER_KEYS.includes(key)
    ) {
      toRemove.push(key);
    }
  }

  for (const key of toRemove) {
    localStorage.removeItem(key);
    cleared += 1;
  }

  return cleared;
}

export function GeneralTab() {
  const [confirming, setConfirming] = useState(false);
  const { previewQuality, setPreviewQuality } = useEditorState();

  const handleReset = () => {
    const count = resetLocalPreferences();
    // Reload so the app picks up fresh defaults everywhere.
    // Give the user a beat to see the count if we ever surface it.
    console.info(`[libi] cleared ${count} localStorage keys`);
    window.location.reload();
  };

  return (
    <div className="space-y-8">
      <UpdatesSection />

      <div>
        <h3 className="text-sm font-semibold text-foreground">Preview quality</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The resolution the editor preview <strong>decodes</strong> video at
          during timeline playback. This is a per-device performance setting and
          does <strong>not</strong> affect exports — exports always render at
          full original quality. Pick <strong>Smooth (720p)</strong> if playback
          stutters or lags on a lower-spec machine.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant={previewQuality === "auto" ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setPreviewQuality("auto")}
          >
            Auto (up to 1080p)
          </Button>
          <Button
            variant={previewQuality === "720p" ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setPreviewQuality("720p")}
          >
            Smooth (720p)
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground">Reset preferences</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Clears locally-stored UI preferences: panel widths, chat/resources
          visibility, selected agent, theme (light/dark), resource sort
          options, and chat scroll positions. Your pieces, files and sessions
          are not touched.
        </p>

        <div className="mt-4 flex items-center gap-2">
          {!confirming ? (
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setConfirming(true)}
            >
              <RotateCcw className="mr-2 size-4" />
              Reset local preferences
            </Button>
          ) : (
            <>
              <Button
                variant="destructive"
                className="cursor-pointer"
                onClick={handleReset}
              >
                Reset and reload
              </Button>
              <Button
                variant="ghost"
                className="cursor-pointer"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
