import type { LayerBitmap, LayerGeometry, LayerRequest, LayerSource } from "@/lib/engine/layer-source";

export interface FakeLayers extends LayerSource {
  requests: LayerRequest[];
  bitmaps: Record<string, ImageBitmap>;
}

export function fakeBitmap(width = 4, height = 4): ImageBitmap {
  return { width, height, close() {} } as unknown as ImageBitmap;
}

/** A LayerSource for renderer tests: records every request; `get` answers from
 *  `bitmaps` (any frame) or throws for the ids in `throwOnGet` (host-side
 *  resilience tests). A bitmap is reported as rendered for the overlay's latest
 *  request — a fresh layer — unless `renderedFor` names the geometry of an
 *  older, held one. */
export function fakeLayers(
  bitmaps: Record<string, ImageBitmap> = {},
  opts: { throwOnGet?: string[]; renderedFor?: Record<string, LayerGeometry> } = {},
): FakeLayers {
  const requests: LayerRequest[] = [];
  return {
    bitmaps,
    requests,
    request(req) {
      requests.push(req);
    },
    get(overlayId, frame): LayerBitmap | null {
      if (opts.throwOnGet?.includes(overlayId)) throw new Error(`layer ${overlayId} failed`);
      const bitmap = bitmaps[overlayId];
      if (!bitmap) return null;
      const latest = requests.findLast((r) => r.overlayId === overlayId);
      const held = opts.renderedFor?.[overlayId];
      const geometry = held ?? (latest && { size: latest.size, pixelRatio: latest.pixelRatio, ...(latest.pad ? { pad: latest.pad } : {}) });
      return geometry ? { frame, bitmap, ...geometry } : null;
    },
  };
}
