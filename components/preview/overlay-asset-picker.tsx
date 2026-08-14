"use client";

import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { useFiles, useFileUpload } from "@/lib/queries/files";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface OverlayAssetPickerProps {
  pieceId: string;
  kind: "image" | "video";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** called with the chosen/uploaded fileId */
  onPick: (fileId: string) => void;
}

/** A standalone dialog for the add-overlay flow: pick an existing piece file of
 *  the requested kind (image/video) OR drag/upload a new one. Resolves to the
 *  chosen fileId via `onPick` and closes. */
export function OverlayAssetPicker({
  pieceId,
  kind,
  open,
  onOpenChange,
  onPick,
}: OverlayAssetPickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: files = [] } = useFiles(pieceId);
  const { upload, isUploading } = useFileUpload(pieceId);

  const matches = files.filter((f) => (f.contentType ?? "").startsWith(kind));

  const pick = (fileId: string) => {
    onPick(fileId);
    onOpenChange(false);
  };

  const uploadFile = async (file: File) => {
    const rec = await upload(file);
    pick(rec.id);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-sm">Add {kind} overlay</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
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
              Drag {kind === "image" ? "an" : "a"} {kind} here, or
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
              accept={`${kind}/*`}
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
                No {kind} files yet — upload one above.
              </p>
            ) : (
              <div className="grid max-h-[280px] grid-cols-4 gap-2 overflow-auto">
                {matches.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="cursor-pointer overflow-hidden rounded border border-border hover:ring-2 hover:ring-blue-500"
                    onClick={() => pick(f.id)}
                    title={f.filename}
                  >
                    {kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/files/by-id/${f.id}/content`}
                        alt={f.filename}
                        className="h-[64px] w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-[64px] w-full items-center justify-center bg-muted text-[10px] text-muted-foreground">
                        Video
                      </div>
                    )}
                    <div className="truncate bg-background px-1 py-0.5 text-center text-[10px] text-muted-foreground">
                      {f.filename}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
