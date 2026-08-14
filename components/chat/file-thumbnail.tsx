"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface FileThumbnailProps {
  file: File;
  onRemove: () => void;
}

function getFileCategory(file: File): "image" | "video" | "pdf" | "text" | "other" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type === "application/pdf") return "pdf";
  if (
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json|xml|yml|yaml|log|js|ts|jsx|tsx|py|rb|go|rs|sh|html|css)$/i.test(file.name)
  )
    return "text";
  return "other";
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
}

/** SVG icon for PDF files */
function PdfIcon() {
  return (
    <svg viewBox="0 0 40 48" className="h-8 w-7" fill="none">
      <rect x="0.5" y="0.5" width="39" height="47" rx="3.5" className="fill-red-900/40 stroke-red-500/50" />
      <rect x="6" y="28" width="28" height="12" rx="2" className="fill-red-500/80" />
      <text x="20" y="37.5" textAnchor="middle" className="fill-white text-[8px] font-bold">PDF</text>
      <rect x="8" y="8" width="18" height="2" rx="1" className="fill-red-400/40" />
      <rect x="8" y="13" width="24" height="2" rx="1" className="fill-red-400/40" />
      <rect x="8" y="18" width="14" height="2" rx="1" className="fill-red-400/40" />
    </svg>
  );
}

/** SVG icon for text/code files */
function TextIcon({ ext }: { ext: string }) {
  return (
    <svg viewBox="0 0 40 48" className="h-8 w-7" fill="none">
      <rect x="0.5" y="0.5" width="39" height="47" rx="3.5" className="fill-muted/30 stroke-border" />
      <rect x="6" y="28" width="28" height="12" rx="2" className="fill-muted-foreground/60" />
      <text x="20" y="37.5" textAnchor="middle" className="fill-white text-[7px] font-bold">
        {(ext || "TXT").slice(0, 4)}
      </text>
      <rect x="8" y="8" width="18" height="2" rx="1" className="fill-muted-foreground/20" />
      <rect x="8" y="13" width="24" height="2" rx="1" className="fill-muted-foreground/20" />
      <rect x="8" y="18" width="14" height="2" rx="1" className="fill-muted-foreground/20" />
    </svg>
  );
}

/** SVG icon for generic files */
function GenericFileIcon({ ext }: { ext: string }) {
  return (
    <svg viewBox="0 0 40 48" className="h-8 w-7" fill="none">
      <path
        d="M4 4a3.5 3.5 0 0 1 3.5-3.5h17L36 11.5V44a3.5 3.5 0 0 1-3.5 3.5h-25A3.5 3.5 0 0 1 4 44V4z"
        className="fill-muted/30 stroke-border"
      />
      <path d="M24.5 0.5V8a3.5 3.5 0 0 0 3.5 3.5h7.5" className="stroke-border" fill="none" />
      {ext && (
        <>
          <rect x="6" y="28" width="28" height="12" rx="2" className="fill-muted-foreground/50" />
          <text x="20" y="37.5" textAnchor="middle" className="fill-white text-[7px] font-bold">
            {ext.slice(0, 4)}
          </text>
        </>
      )}
    </svg>
  );
}

/** Captures a thumbnail from a video File */
function useVideoThumbnail(file: File, enabled: boolean): string | null {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    const handleSeeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      setThumb(canvas.toDataURL("image/jpeg", 0.7));
      URL.revokeObjectURL(url);
      video.removeEventListener("seeked", handleSeeked);
    };

    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(1, video.duration / 2);
    });

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file, enabled]);

  return thumb;
}

export default function FileThumbnail({ file, onRemove }: FileThumbnailProps) {
  const category = getFileCategory(file);
  const ext = getExtension(file.name);
  const videoThumb = useVideoThumbnail(file, category === "video");

  const imageUrl = category === "image" ? URL.createObjectURL(file) : null;
  const imgRef = useRef(imageUrl);

  // Revoke object URL on unmount
  useEffect(() => {
    return () => {
      if (imgRef.current) URL.revokeObjectURL(imgRef.current);
    };
  }, []);

  return (
    <div className="group/thumb relative flex-shrink-0">
      <div className="h-16 w-16 overflow-hidden rounded-lg border border-border bg-surface">
        {category === "image" && imageUrl && (
          <img src={imageUrl} alt={file.name} className="h-full w-full object-cover" />
        )}
        {category === "video" && (
          videoThumb ? (
            <div className="relative h-full w-full">
              <img src={videoThumb} alt={file.name} className="h-full w-full object-cover" />
              {/* Play triangle overlay */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-black/50">
                  <svg viewBox="0 0 10 12" className="ml-0.5 h-2.5 w-2.5 fill-white">
                    <polygon points="0,0 10,6 0,12" />
                  </svg>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <GenericFileIcon ext={ext} />
            </div>
          )
        )}
        {category === "pdf" && (
          <div className="flex h-full w-full items-center justify-center">
            <PdfIcon />
          </div>
        )}
        {category === "text" && (
          <div className="flex h-full w-full items-center justify-center">
            <TextIcon ext={ext} />
          </div>
        )}
        {category === "other" && (
          <div className="flex h-full w-full items-center justify-center">
            <GenericFileIcon ext={ext} />
          </div>
        )}
      </div>
      {/* File name tooltip on hover */}
      <div className="mt-0.5 max-w-16 truncate text-center text-[10px] text-muted-foreground">
        {file.name}
      </div>
      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface border border-border text-muted-foreground opacity-0 transition-opacity hover:bg-destructive hover:text-destructive-foreground hover:border-destructive group-hover/thumb:opacity-100 cursor-pointer"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
