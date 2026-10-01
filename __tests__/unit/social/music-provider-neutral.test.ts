/** Owner requirement 2026-09-28: song matching and its UI go through the provider
 *  abstraction only. These files may name no provider and no provider field. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILES = [
  "lib/social/music-match.ts",
  "lib/audio-rights/platform-picks.ts",
  "app/api/files/by-id/[fileId]/music-match/route.ts",
  "app/api/files/by-id/[fileId]/platform-picks/route.ts",
  "mcp/tools/audio-clip-tools.ts",
  "mcp/tools/audio-rights-tools.ts",
  "components/social/music/track-picker.tsx",
  "components/social/music/use-preview-player.ts",
  "components/social/music/music-block.tsx",
  "components/social/composer/music-step.tsx",
  "components/preview/audio-rights-section.tsx",
  "components/preview/song-on-social.tsx",
];
const PROVIDER_FIELDS = ["musicSoundInfo", "audioConfiguration", "commercialMusicId", "tiktokSettings", "platformSpecificData", "call_tool"];

describe("provider-neutral music files", () => {
  it.each(FILES)("%s names no provider", (f) => {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf-8");
    expect(src).not.toMatch(/zernio/i);
    expect(src).not.toMatch(/social\/providers\//);
    for (const field of PROVIDER_FIELDS) expect(src).not.toContain(field);
  });
});
