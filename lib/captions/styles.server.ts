/** SERVER-ONLY caption-style helpers.
 *
 *  Splits the user-preset merge (which reads the filesystem via
 *  `lib/overlays/preset-store` → `lib/libi-home` → `fs`) out of the client-safe
 *  `styles.ts`. Import this ONLY from server code (MCP tools, route handlers) —
 *  never from a client component, or `fs` leaks into the browser bundle. */
import type { CaptionStyle } from "@/lib/captions/types";
import type { OverlayPreset } from "@/lib/overlays/presets";
import { listPresets } from "@/lib/overlays/preset-store";
import { CAPTION_STYLES } from "@/lib/captions/styles";

/** Map a unified `OverlayPreset` (kind "text") whose fields look like a caption
 *  style into a `CaptionStyle`. Pulls the recognized look keys out of
 *  `preset.fields`; `color` defaults to white when the preset omits it. */
function presetToCaptionStyle(preset: OverlayPreset): CaptionStyle {
  const f = preset.fields as Record<string, unknown>;
  const style: CaptionStyle = {
    id: preset.id,
    label: preset.name,
    source: preset.source,
    color: typeof f.color === "string" ? f.color : "#ffffff",
  };
  const dst = style as unknown as Record<string, unknown>;
  for (const key of ["highlightColor", "stroke", "shadow", "background", "reveal", "fontFamily", "fontWeight"] as const) {
    if (f[key] != null) dst[key] = f[key];
  }
  return style;
}

/** Bundled curated styles merged with any user caption styles (text-kind
 *  presets). User styles shadow bundled ones by id. Server-only (reads disk). */
export async function listCaptionStyles(): Promise<CaptionStyle[]> {
  const presets = await listPresets("text");
  const userStyles = presets.filter((p) => p.source === "user").map(presetToCaptionStyle);
  const userIds = new Set(userStyles.map((s) => s.id));
  return [...CAPTION_STYLES.filter((s) => !userIds.has(s.id)), ...userStyles];
}
