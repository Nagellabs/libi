import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/db/settings";
import { trackServerEvent } from "@/lib/analytics/server";

const PERSONAS = new Set([
  "solo-creator",
  "entrepreneur",
  "video-editor",
  "marketing",
  "agency",
  "studio",
  "developer",
  "curious",
]);

export async function PUT(request: Request): Promise<Response> {
  let body: { persona?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const persona = body.persona;
  if (!persona || !PERSONAS.has(persona)) {
    return NextResponse.json({ error: "unknown persona" }, { status: 400 });
  }
  updateSettings({ onboardingPersona: persona, personaSelectedAt: new Date() });
  void trackServerEvent("persona_selected", { persona });
  return NextResponse.json({ ok: true, persona });
}
