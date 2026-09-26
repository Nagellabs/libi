import { NextResponse } from "next/server";
import { loadCustomEffectPayload } from "@/lib/effects/packages";

/**
 * Ships custom effect packages to the browser: each entry is the validated
 * manifest, its `animate.js` source and the source's sha256 (only packages that
 * validate). The page registers curve-backed defs from them and hands the
 * source to the effect sandbox, which samples it — the page never compiles or
 * runs it (lib/effects/custom-curves.ts).
 */
export async function GET() {
  return NextResponse.json(loadCustomEffectPayload());
}
