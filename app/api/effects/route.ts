import { NextResponse } from "next/server";
import { loadCustomEffectPayload } from "@/lib/effects/packages";

/**
 * Ships custom effect packages to the browser: each entry is the validated
 * manifest + its `animate.js` source (only packages that compile cleanly).
 * The client compiles + registers them via the client-safe `compileCustomEffect`
 * — it never imports this server-only loader.
 */
export async function GET() {
  return NextResponse.json(loadCustomEffectPayload());
}
