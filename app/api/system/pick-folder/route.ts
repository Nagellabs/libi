import { NextResponse } from "next/server";
import { pickFolder } from "@/lib/system/pick-folder";

export const dynamic = "force-dynamic";

/**
 * Open a native folder dialog from libi's own server (the browser case). One
 * at a time: a second request while a dialog is open is 409. The outcome is
 * never an error status — `unavailable` carries its reason in the body.
 * Same-origin only, like every other API route (proxy.ts).
 */
export async function POST(req: Request): Promise<Response> {
  let initialPath: string | null = null;
  try {
    const body = (await req.json()) as { initialPath?: unknown };
    if (typeof body?.initialPath === "string") initialPath = body.initialPath;
  } catch {
    // No body, or not JSON: no start folder.
  }
  // An abandoned request (tab closed, fetch aborted) closes the dialog and frees the one-at-a-time slot.
  const outcome = await pickFolder({ initialPath, signal: req.signal });
  if (outcome.status === "busy") return NextResponse.json(outcome, { status: 409 });
  return NextResponse.json(outcome);
}
