import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/settings";

export async function GET(): Promise<Response> {
  const s = getSettings();
  return NextResponse.json({
    needsPersona: s.personaSelectedAt == null,
    persona: s.onboardingPersona,
    needsOnboarding: !s.agentEverConnected,
    agentEverConnected: s.agentEverConnected,
    // Armed server-side on first agent connect (session-manager's
    // markAgentConnected), final once dismissed — see lib/db/settings.ts.
    demoOffered: s.onboardingDemoOfferedAt != null && s.onboardingDemoDismissedAt == null,
  });
}

/**
 * Task 13: persists that the first-run demo offer was resolved — dismissed
 * OR taken, the chip treats both the same (see chat-panel.tsx /
 * terminal-panel.tsx) — so it never reappears, including across a reload
 * that happens before the user acts on it.
 */
export async function PUT(request: Request): Promise<Response> {
  let body: { dismissDemoOffer?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.dismissDemoOffer !== true) {
    return NextResponse.json({ error: "unsupported update" }, { status: 400 });
  }
  updateSettings({ onboardingDemoDismissedAt: new Date() });
  return NextResponse.json({ ok: true });
}
