import { NextResponse } from "next/server";
import { listCaptionStyles } from "@/lib/captions/styles.server";

/**
 * GET /api/caption-styles
 *
 * List all caption styles shown in the Style tab: the bundled curated looks
 * merged with any user-created styles (text-kind presets converted to styles).
 * Returns `{ styles }`. Drives the `useCaptionStyles` hook + the style picker.
 */
export async function GET() {
  const styles = await listCaptionStyles();
  return NextResponse.json({ styles }, { status: 200 });
}
