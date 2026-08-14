"use client";

import { useEffect, useState, type RefObject } from "react";
import type { FileRecord } from "@/lib/db/schema/types";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioAssetView } from "@/components/editor/audio-asset-view";
import { ResizableMediaBox } from "@/components/editor/resizable-media-box";
import {
  PreviewProxyBadge,
  isProxyDownscaled,
} from "@/components/preview/preview-proxy-badge";

interface Props {
  asset: FileRecord;
  /** Shared media-element ref — holds the <video> OR <audio> element so the
   *  panel's transcript/summary click-to-seek works for both asset types. */
  mediaRef: RefObject<HTMLMediaElement | null>;
  onTimeUpdate: (t: number) => void;
}

export function AssetMediaView({ asset, mediaRef, onTimeUpdate }: Props) {
  const isVideo = asset.type === "video";
  const contentUrl = `/api/files/by-id/${asset.id}/content`;
  const ct = asset.contentType ?? "";

  // Aspect ratio for the resizable box. Upload-time metadata when present;
  // otherwise measured from the media element once it loads.
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  // Drop the stale measurement on the render where the asset switches
  // (previous-state pattern — pre-paint, no effect cascade).
  const [prevAssetId, setPrevAssetId] = useState(asset.id);
  if (asset.id !== prevAssetId) {
    setPrevAssetId(asset.id);
    setMeasuredAspect(null);
  }
  const aspect =
    asset.mediaWidth && asset.mediaHeight
      ? asset.mediaWidth / asset.mediaHeight
      : measuredAspect;

  if (isVideo || asset.type === "image") {
    return (
      <div className="h-full w-full bg-black/20">
        {/* Keyed per asset so a stored manual size is re-read and the
            container-resize baseline resets when switching assets. */}
        <ResizableMediaBox key={asset.id} assetId={asset.id} aspect={aspect}>
          {isVideo ? (
            <VideoBranch
              asset={asset}
              mediaRef={mediaRef}
              onTimeUpdate={onTimeUpdate}
              onAspect={setMeasuredAspect}
            />
          ) : (
            <img
              src={contentUrl}
              alt={asset.name || asset.filename}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setMeasuredAspect(img.naturalWidth / img.naturalHeight);
                }
              }}
              className="h-full w-full rounded object-contain"
            />
          )}
        </ResizableMediaBox>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-black/20 p-4">
      {asset.type === "audio" && (
        <AudioAssetView
          asset={asset}
          mediaRef={mediaRef}
          onTimeUpdate={onTimeUpdate}
        />
      )}
      {ct === "application/pdf" && (
        <embed src={contentUrl} type="application/pdf" className="h-full w-full" />
      )}
      {(ct.startsWith("text/") || ct === "application/json") && (
        <TextViewer url={contentUrl} />
      )}
      {asset.type !== "audio" &&
        ct !== "application/pdf" &&
        !ct.startsWith("text/") &&
        ct !== "application/json" && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <span className="text-sm">{asset.filename}</span>
          </div>
        )}
    </div>
  );
}

function VideoBranch({
  asset,
  mediaRef,
  onTimeUpdate,
  onAspect,
}: {
  asset: FileRecord;
  mediaRef: RefObject<HTMLMediaElement | null>;
  onTimeUpdate: (t: number) => void;
  /** Reports the decoded aspect ratio for assets missing upload metadata. */
  onAspect: (aspect: number) => void;
}) {
  const proxyReady = asset.proxyStatus === "ready" && !!asset.proxyFilename;
  // When the proxy is a genuine downscale, expose a "View original" toggle.
  const downscaled = isProxyDownscaled(asset.proxyHeight, asset.mediaHeight);
  const [showOriginal, setShowOriginal] = useState(false);

  // Reset to the (scrub-friendly) proxy whenever the asset changes —
  // adjusted during render (previous-state pattern), not in an effect.
  const [prevAssetId, setPrevAssetId] = useState(asset.id);
  if (asset.id !== prevAssetId) {
    setPrevAssetId(asset.id);
    setShowOriginal(false);
  }

  const useProxy = proxyReady && !showOriginal;
  const videoUrl = useProxy
    ? `/api/files/by-id/${asset.id}/proxy`
    : `/api/files/by-id/${asset.id}/content`;

  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    const onUpdate = () => onTimeUpdate(v.currentTime);
    v.addEventListener("timeupdate", onUpdate);
    v.addEventListener("seeking", onUpdate);
    v.addEventListener("seeked", onUpdate);
    return () => {
      v.removeEventListener("timeupdate", onUpdate);
      v.removeEventListener("seeking", onUpdate);
      v.removeEventListener("seeked", onUpdate);
    };
  }, [mediaRef, asset.id, onTimeUpdate]);

  return (
    // The ResizableMediaBox parent owns the box dimensions; the video just
    // fills it (box aspect matches the video's, so object-contain is exact).
    <div className="relative h-full w-full">
      <video
        ref={(el) => {
          mediaRef.current = el;
        }}
        src={videoUrl}
        controls
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            onAspect(v.videoWidth / v.videoHeight);
          }
        }}
        className="h-full w-full rounded object-contain"
      />
      {downscaled && (
        <div className="absolute left-2 top-2 flex items-center gap-2">
          {useProxy ? (
            <>
              <PreviewProxyBadge
                proxyHeight={asset.proxyHeight}
                mediaHeight={asset.mediaHeight}
              />
              <button
                type="button"
                onClick={() => setShowOriginal(true)}
                className="cursor-pointer rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white/90 shadow-sm backdrop-blur-sm hover:bg-black/75"
              >
                View original
              </button>
            </>
          ) : (
            <>
              <div className="pointer-events-none select-none rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white/90 shadow-sm backdrop-blur-sm">
                Original · {asset.mediaHeight}p
              </div>
              <button
                type="button"
                onClick={() => setShowOriginal(false)}
                className="cursor-pointer rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white/90 shadow-sm backdrop-blur-sm hover:bg-black/75"
              >
                View preview
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TextViewer({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    fetch(url, { signal: c.signal })
      .then((r) => r.text())
      .then(setText)
      .catch(() => {
        if (!c.signal.aborted) setText("Failed to load file");
      });
    return () => c.abort();
  }, [url]);

  if (text === null) {
    return (
      <div className="w-full max-w-3xl space-y-2 p-4">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }

  return (
    <pre className="max-h-full w-full max-w-3xl overflow-auto rounded bg-background p-4 font-mono text-xs text-foreground">
      {text}
    </pre>
  );
}
