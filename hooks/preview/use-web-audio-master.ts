"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { WebAudioEngine } from "@/lib/audio/web-audio-engine";
import type { AudioMasterControl } from "@/hooks/preview/use-transport";

/**
 * Owns the audio-master `WebAudioEngine` — the sole preview audio path. Returns
 * a STABLE `AudioMasterControl` for the transport (reads the audio clock +
 * delegates play/pause/seek/speed) plus the engine ref so the editor can sync
 * the clip set + master volume AFTER the transport is created (the volume
 * depends on the transport, so syncing can't live inside this hook without a
 * circular dependency).
 */
export function useWebAudioMaster(): {
  control: AudioMasterControl;
  engineRef: RefObject<WebAudioEngine | null>;
} {
  const engineRef = useRef<WebAudioEngine | null>(null);

  useEffect(() => {
    const engine = new WebAudioEngine((fileId) => `/api/files/by-id/${fileId}/content`);
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
