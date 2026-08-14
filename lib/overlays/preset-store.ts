import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { isValidPresetSlug, type OverlayPreset } from "@/lib/overlays/presets";
import { BUNDLED_OVERLAY_PRESETS } from "@/lib/overlays/caption-presets";

function presetsDir(): string { return join(getLibiHome(), "overlay-presets"); }
function presetPath(id: string): string { return join(presetsDir(), `${id}.json`); }

export async function listUserPresets(): Promise<OverlayPreset[]> {
  let names: string[];
  try { names = await fs.readdir(presetsDir()); } catch { return []; }
  const out: OverlayPreset[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fs.readFile(join(presetsDir(), n), "utf8"));
      if (raw && typeof raw.id === "string" && typeof raw.kind === "string") out.push({ ...raw, source: "user" });
    } catch { /* skip a corrupt file */ }
  }
  return out;
}

export async function getUserPreset(id: string): Promise<OverlayPreset | null> {
  if (!isValidPresetSlug(id)) return null;
  try { return { ...JSON.parse(await fs.readFile(presetPath(id), "utf8")), source: "user" }; }
  catch { return null; }
}

export async function saveUserPreset(p: OverlayPreset): Promise<void> {
  if (!isValidPresetSlug(p.id)) throw new Error(`invalid preset id: ${p.id}`);
  await fs.mkdir(presetsDir(), { recursive: true });
  const now = new Date().toISOString();
  // `createdAt` is preserved when the caller passes it (override path); a fresh
  // save gets `now`. `updatedAt` is bumped to `now` on every write.
  const record: OverlayPreset = {
    ...p,
    source: "user",
    createdAt: p.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(presetPath(p.id), JSON.stringify(record, null, 2), "utf8");
}

export async function deleteUserPreset(id: string): Promise<void> {
  if (!isValidPresetSlug(id)) return;
  try { await fs.unlink(presetPath(id)); } catch { /* already gone */ }
}

/** Bundled + user presets, user shadowing bundled by id, optionally filtered by kind. */
export async function listPresets(kind?: OverlayPreset["kind"]): Promise<OverlayPreset[]> {
  const user = await listUserPresets();
  const userIds = new Set(user.map((p) => p.id));
  const merged = [...BUNDLED_OVERLAY_PRESETS.filter((p) => !userIds.has(p.id)), ...user];
  return kind ? merged.filter((p) => p.kind === kind) : merged;
}
