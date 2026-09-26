"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { WebAudioEngine, type ProxyState, type ProxyStatus, type UnplayableAudioClip } from "@/lib/audio/web-audio-engine";
import type { AudioMasterControl } from "@/hooks/preview/use-transport";

/**
 * Owns the audio-master `WebAudioEngine` — the sole preview audio path. Returns
 * a STABLE `AudioMasterControl` for the transport (reads the audio clock +
 * delegates play/pause/seek/speed) plus the engine ref so the editor can sync
 * the clip set + master volume AFTER the transport is created (the volume
 * depends on the transport, so syncing can't live inside this hook without a
 * circular dependency).
 */
export function useWebAudioMaster(
  /** Told once per clip whose audio can't be played from any source. */
  onUnplayable?: (info: UnplayableAudioClip) => void,
  /** Whether a file has, will have, or can never have a proxy (see
   *  WebAudioEngineOptions.proxyState). Read at call time. */
  proxyState?: (fileId: string) => ProxyState | ProxyStatus,
): {
  control: AudioMasterControl;
  engineRef: RefObject<WebAudioEngine | null>;
} {
  const engineRef = useRef<WebAudioEngine | null>(null);
  // Latest callback, read at call time, so the engine is never rebuilt for it.
  const onUnplayableRef = useRef(onUnplayable);
  useEffect(() => {
    onUnplayableRef.current = onUnplayable;
  }, [onUnplayable]);
  const proxyStateRef = useRef(proxyState);
  useEffect(() => {
    proxyStateRef.current = proxyState;
  }, [proxyState]);

  useEffect(() => {
    // Audio reads the ORIGINAL; if the browser can't decode its track, the
    // engine falls back to the proxy's AAC-LC transcode — only for a file
    // that has one, or once it lands (proxyState).
    const engine = new WebAudioEngine(
      (fileId) => `/api/files/by-id/${fileId}/content`,
      1,
      (fileId) => `/api/files/by-id/${fileId}/proxy`,
      {
        onUnplayable: (info) => onUnplayableRef.current?.(info),
        proxyState: (fileId) => proxyStateRef.current?.(fileId) ?? "ready",
      },
    );
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const control = useMemo<AudioMasterControl>(
    () => ({
      getTime: () => engineRef.current?.getCompositionTime() ?? 0,
      play: () => engineRef.current?.play(),
      pause: () => engineRef.current?.pause(),
      seek: (sec: number) => engineRef.current?.seek(sec),
      setSpeed: (s: number) => engineRef.current?.setSpeed(s),
    }),
    [],
  );

  return { control, engineRef };
}
