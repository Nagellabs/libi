"use client";

import { useRef, useState } from "react";
import { ChevronLeftIcon, ImageIcon, LinkIcon, MusicIcon, PlusIcon, UploadIcon, VideoIcon } from "lucide-react";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";
import type { StoryboardCard } from "@/lib/storyboard/types";
import { cardAssetTargets, type AssetTarget, type AssetTargetGroup } from "@/lib/storyboard/asset-targets";
import type { ReferenceFamily } from "@/lib/storyboard/reference-targets";
import { useFiles, useFileUpload } from "@/lib/queries/files";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface AddAssetMenuProps {
  pieceId: string;
  card: StoryboardCard;
  schema?: ModelSchema;
  onSetParam: (key: string, fileId: string) => void;
  onSetSketchImage: (slotId: string, fileId: string) => void;
  onSetReference?: (key: string, fromCardId: string) => void;
  otherCards?: { cardId: string; label: string }[];
}

const FAMILY_ICON: Record<ReferenceFamily, typeof ImageIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: MusicIcon,
};

const GROUP_ORDER: AssetTargetGroup[] = ["Keyframes", "Sketches", "References"];

/** ONE centered dialog for adding/importing any asset on a card — keyframes,
 *  sketches, and references. Step 1 lists what the card's model supports (derived
 *  from its cached API schema). Step 2 picks an existing piece file, drops/uploads
 *  a new one, or (video reference) live-links a scene. */
export function AddAssetMenu({
  pieceId,
  card,
  schema,
  onSetParam,
  onSetSketchImage,
  onSetReference,
  otherCards,
}: AddAssetMenuProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AssetTarget | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: files = [] } = useFiles(pieceId);
  const { upload, isUploading } = useFileUpload(pieceId);

  const targets = cardAssetTargets(card, schema);
  if (targets.length === 0) return null;

  const close = () => {
    setOpen(false);
    setTarget(null);
    setDragOver(false);
  };

  const apply = (fileId: string) => {
    if (!target) return;
    if (target.kind === "sketch" && target.slotId) onSetSketchImage(target.slotId, fileId);
    else if (target.paramKey) onSetParam(target.paramKey, fileId);
    close();
  };

  const uploadFile = async (file: File) => {
    if (!target) return;
    const rec = await upload(file);
    apply(rec.id);
  };

  const onUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await uploadFile(file);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await uploadFile(file);
  };

  const matches = target
    ? files.filter((f) => (f.contentType ?? "").startsWith(`${target.family}/`))
    : [];
  const showInherit = target?.supportsInherit && !!onSetReference && !!otherCards?.length;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="cursor-pointer flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground/80"
            aria-label="Add or import asset"
          />
        }
      >
        <PlusIcon className="size-3" />
        Add / import
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px]">
        {!target ? (
          <div className="flex flex-col gap-3">
            <DialogTitle className="text-sm">Add / import</DialogTitle>
            {GROUP_ORDER.map((group) => {
              const items = targets.filter((t) => t.group === group);
              // Keyframes/Sketches always exist; References may be empty — show a
              // note so the absence is understood, not confusing.
              if (items.length === 0 && group !== "References") return null;
              return (
                <div key={group}>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    {group}
                  </div>
                  {items.length === 0 ? (
                    <p className="px-1 text-[11px] text-muted-foreground/80">
                      This model has no reference inputs — it conditions on the keyframes above.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {items.map((t) => {
                        const Icon = FAMILY_ICON[t.family];
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className="cursor-pointer flex items-center gap-2.5 rounded px-2 py-2 text-left text-[13px] hover:bg-muted"
                            onClick={() => setTarget(t)}
                          >
                            <Icon className="size-4 text-muted-foreground" />
                            <span className="flex-1">{t.label}</span>
                            {t.filled && <span className="text-[10px] text-muted-foreground/70">set</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Header with a prominent Back button */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTarget(null)}
                className="cursor-pointer flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Back"
              >
                <ChevronLeftIcon className="size-4" />
                Back
              </button>
              <DialogTitle className="text-sm">{target.label}</DialogTitle>
            </div>

            {showInherit && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  Live link
                </div>
                <div className="flex flex-col gap-0.5">
                  {otherCards!.map((o) => (
                    <button
                      key={o.cardId}
                      type="button"
                      className="cursor-pointer flex items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted"
                      onClick={() => {
                        onSetReference!(target.paramKey!, o.cardId);
                        close();
                      }}
                    >
                      <LinkIcon className="size-3.5 text-muted-foreground" />
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Drag-and-drop zone + Upload button */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={[
                "flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-center transition-colors",
                dragOver ? "border-blue-500 bg-blue-500/5" : "border-border",
              ].join(" ")}
            >
              <UploadIcon className="size-5 text-muted-foreground/70" />
              <p className="text-[12px] text-muted-foreground">
                Drag {target.family === "image" || target.family === "audio" ? "an" : "a"} {target.family} here, or
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="cursor-pointer rounded-md bg-blue-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {isUploading ? "Uploading…" : "Upload a file"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={`${target.family}/*`}
                className="hidden"
                onChange={onUploadChange}
              />
            </div>

            {/* Existing piece files */}
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                Or pick from this piece
              </div>
              {matches.length === 0 ? (
                <p className="py-2 text-[12px] text-muted-foreground">
                  No {target.family} files in this piece yet.
                </p>
              ) : (
                <div className="grid max-h-[280px] grid-cols-4 gap-2 overflow-auto">
                  {matches.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className="cursor-pointer overflow-hidden rounded border border-border hover:ring-2 hover:ring-blue-500"
                      onClick={() => apply(f.id)}
                      title={f.filename}
                    >
                      {target.family === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/files/by-id/${f.id}/content`}
                          alt={f.filename}
                          className="h-[80px] w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-[80px] w-full items-center justify-center truncate bg-muted px-1 text-center text-[10px] text-muted-foreground">
                          {f.filename}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
