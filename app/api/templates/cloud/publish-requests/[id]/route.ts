import { NextResponse } from "next/server";
import { trackServerEvent } from "@/lib/analytics/server";
import { navigationEmitter } from "@/lib/navigation-events";
import { discardPublishRequest, PUBLISHING_NOW } from "@/lib/templates/cloud/publish-requests";

export const dynamic = "force-dynamic";

/**
 * DELETE → the review panel's "Don't publish": the request is forgotten and
 * nothing was sent anywhere. `{ ok: true }`; 404 when there is none; 409 while
 * its publish is running (stop that job first).
 */
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const outcome = discardPublishRequest(id);
  if (outcome === "not_found") return NextResponse.json({ error: "That publish request is gone." }, { status: 404 });
  if (outcome === "publishing") return NextResponse.json({ error: PUBLISHING_NOW, code: "publishing" }, { status: 409 });
  trackServerEvent("template_publish_discarded");
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return NextResponse.json({ ok: true });
}
