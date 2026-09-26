// The same fixture as libi-site __tests__/templates/fixtures.ts#makeScaffold,
// byte for byte from the doc comment down, so the preflight parity test feeds
// the app exactly the scaffold the site's own tests feed parsePrepare.
import type { TemplateScaffold } from "@/lib/templates/scaffold-schema";

/**
 * A minimal VALID scaffold (the scaffold-schema test parses it): one text
 * overlay bound to one text slot, one hosted video asset.
 */
export function makeScaffold(patch: Partial<TemplateScaffold> = {}): TemplateScaffold {
  return {
    schema: 1,
    name: "Hook + caption",
    description: "A three-second hook with a caption slot.",
    tags: ["hook", "caption"],
    canvas: { width: 1080, height: 1920, fps: 30 },
    duration: 3,
    slots: [{ key: "headline", kind: "text", label: "Headline", required: true }],
    overlays: [
      {
        key: "headline",
        kind: "text",
        displayName: "Headline",
        rect: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
        startTime: 0,
        duration: 3,
        z: 1,
        opacity: 1,
        text: { slot: "headline" },
        font: "bold 72px Inter",
        color: "#ffffff",
        align: "center",
      },
    ],
    audioClips: [],
    assets: [{ ref: "clip", kind: "video", url: "https://example.com/clip.mp4" }],
    fonts: [],
    captionStyles: [],
    ...patch,
  };
}
