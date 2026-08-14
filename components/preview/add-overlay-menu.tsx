"use client";

import * as React from "react";
import { Type, Image as ImageIcon, Film, Code2, Box, Target } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  defaultOverlayInit,
  type NewOverlayCtx,
  type NewOverlayPayload,
} from "@/lib/overlays/new-overlay-defaults";

export interface AddOverlayMenuProps {
  resolveCtx: () => Omit<NewOverlayCtx, "fileId" | "group">;
  pieceId: string;
  /** Text → defaultOverlayInit("text", resolveCtx()) */
  onCreateDirect: (payload: NewOverlayPayload) => void;
  /** Image/Video → opens the asset picker */
  onPickAsset: (kind: "image" | "video") => void;
  /** Code/3D/Tracked → opens the agent composer (M2) */
  onAskAgent: (kind: "code" | "three" | "tracked") => void;
  /** The "+ Add" button element used as the popover trigger. */
  trigger: React.ReactNode;
}

const itemClass =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left outline-hidden hover:bg-white/10 hover:text-foreground focus-visible:bg-white/10 focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring cursor-pointer";

export function AddOverlayMenu({
  resolveCtx,
  onCreateDirect,
  onPickAsset,
  onAskAgent,
  trigger,
}: AddOverlayMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  function run(fn: () => void) {
    fn();
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent align="start" className="w-44 gap-0.5 p-1">
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onCreateDirect(defaultOverlayInit("text", resolveCtx())))}
        >
          <Type className="size-4" />
          Text
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onPickAsset("image"))}
        >
          <ImageIcon className="size-4" />
          Image
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onPickAsset("video"))}
        >
          <Film className="size-4" />
          Video
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onAskAgent("code"))}
        >
          <Code2 className="size-4" />
          Code
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onAskAgent("three"))}
        >
          <Box className="size-4" />
          3D
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => run(() => onAskAgent("tracked"))}
        >
          <Target className="size-4" />
          Tracked
        </button>
      </PopoverContent>
    </Popover>
  );
}
