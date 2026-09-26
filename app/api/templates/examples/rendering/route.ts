import { NextResponse } from "next/server";
import { exampleRenderStatus } from "@/lib/templates/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/templates/examples/rendering — `{ templateIds, failed }`:
 *  - `templateIds`: the templates with a `template_example` render queued or
 *    running (whoever started it: the agent's create, or the page's Render
 *    preview), so their cards name the wait;
 *  - `failed`: `{ templateId, error }` for each template whose last render
 *    failed, so a card back on "Render preview" says why (the job's own error,
 *    scrubbed and clamped — lib/templates/store.ts#exampleRenderStatus).
 */
export async function GET(): Promise<Response> {
  const { rendering, failed } = exampleRenderStatus();
  return NextResponse.json({
    templateIds: [...rendering],
    failed: [...failed].map(([templateId, error]) => ({ templateId, error })),
  });
}
