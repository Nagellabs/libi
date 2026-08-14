import { NextResponse } from "next/server";
import { loadBundledTemplate } from "@/lib/instructions/bundled-template";
import { getInstructionsStatus, readInstructionsOverride } from "@/lib/instructions/override";
import { renderDialect } from "@/lib/instructions/dialect";

export async function GET(): Promise<Response> {
  const status = getInstructionsStatus();
  const raw =
    status.source === "override"
      ? readInstructionsOverride() ?? ""
      : loadBundledTemplate();
  // The Instructions page renders the CLAUDE (default) dialect — resolve any
  // dialect-conditional blocks so the doc reads as the shipped CLAUDE.md would.
  const content = renderDialect(raw, "claude");
  return NextResponse.json({ ...status, content });
}
