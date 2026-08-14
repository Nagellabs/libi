/** Client-side media metadata probing using browser APIs */

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
}

const PROBE_TIMEOUT_MS = 5000;

function probeVideo(file: File): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({});
    }, PROBE_TIMEOUT_MS);

    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      const result: MediaMetadata = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      cleanup();
      resolve(result);
    };

    video.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      resolve({});
    };

    video.src = url;
  });
}

function probeAudio(file: File): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";

    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({});
    }, PROBE_TIMEOUT_MS);

    audio.onloadedmetadata = () => {
      clearTimeout(timeout);
      const result: MediaMetadata = { duration: audio.duration };
      cleanup();
      resolve(result);
    };

    audio.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      resolve({});
    };

    audio.src = url;
  });
}

function probeImage(file: File): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    const cleanup = () => {
      URL.revokeObjectURL(url);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({});
    }, PROBE_TIMEOUT_MS);

    img.onload = () => {
      clearTimeout(timeout);
      const result: MediaMetadata = {
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      cleanup();
      resolve(result);
    };

    img.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      resolve({});
    };

    img.src = url;
  });
}

export async function probeMediaMetadata(file: File): Promise<MediaMetadata> {
  const type = file.type;
  if (!type) return {};
  if (type.startsWith("video/")) return probeVideo(file);
  if (type.startsWith("audio/")) return probeAudio(file);
  if (type.startsWith("image/")) return probeImage(file);
  return {};
}
