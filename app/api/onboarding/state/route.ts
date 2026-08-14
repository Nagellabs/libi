import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";

export async function GET(): Promise<Response> {
  const s = getSettings();
  return NextResponse.json({
    needsPersona: s.personaSelectedAt == null,
    persona: s.onboardingPersona,
    needsOnboarding: !s.agentEverConnected,
    agentEverConnected: s.agentEverConnected,
  });
}
