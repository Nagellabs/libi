import { NextResponse } from "next/server";
import { getSettings, updateSettings, type AppSettings } from "@/lib/db/settings";
import { isSetupAgentId } from "@/lib/agents/setup/registry";

/**
 * Whether the Agents tab's setup wizard counts as finished. It is recorded when
 * the wizard's Open chat succeeds. An install from before the wizard recorded
 * anything has no such record — but an agent that has connected while no pick was
 * ever recorded can only be one: a pick is recorded before the download that lets
 * an agent connect at all. Those users set up long ago and must not be walked
 * through a first onboarding again.
 */
function wizardFinished(s: AppSettings): boolean {
  return s.agentWizardFinishedAt != null || (s.agentEverConnected && s.agentWizardChosenAt == null);
}

/** Where the user is in onboarding, as both GET and a PUT's answer report it. */
function onboardingState(s: AppSettings) {
  return {
    needsPersona: s.personaSelectedAt == null,
    persona: s.onboardingPersona,
    needsOnboarding: !s.agentEverConnected,
    agentEverConnected: s.agentEverConnected,
    // Armed server-side on first agent connect (session-manager's
    // markAgentConnected), final once dismissed — see lib/db/settings.ts.
    demoOffered: s.onboardingDemoOfferedAt != null && s.onboardingDemoDismissedAt == null,
    wizardAgentChosenAt: s.agentWizardChosenAt,
    wizardAgent: s.agentWizardAgent !== null && isSetupAgentId(s.agentWizardAgent) ? s.agentWizardAgent : null,
    wizardFinishedAt: s.agentWizardFinishedAt,
    wizardFinished: wizardFinished(s),
  };
}

export async function GET(): Promise<Response> {
  return NextResponse.json(onboardingState(getSettings()));
}

/**
 * Records onboarding progress. Any of:
 * - `dismissDemoOffer: true` — the first-run demo offer was resolved, dismissed
 *   OR taken (the chip treats both the same, see chat-panel.tsx /
 *   terminal-panel.tsx), so it never reappears, including across a reload that
 *   happens before the user acts on it.
 * - `wizardAgentChosen: <agent>` — the setup wizard's agent was picked. The time
 *   of the FIRST pick is kept; the agent follows the latest pick until the wizard
 *   is finished, after which neither changes.
 * - `wizardFinished: true` — the wizard reached its end. The first time is kept.
 *
 * The whole body is validated before anything is written. The answer is the
 * onboarding state as the write left it — what GET would now report — so a client
 * can take it as it is instead of fetching it again.
 */
export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "unsupported update" }, { status: 400 });
  }
  const { dismissDemoOffer, wizardAgentChosen, wizardFinished: finished } = body as Record<string, unknown>;
  if (dismissDemoOffer === undefined && wizardAgentChosen === undefined && finished === undefined) {
    return NextResponse.json({ error: "unsupported update" }, { status: 400 });
  }
  if (dismissDemoOffer !== undefined && dismissDemoOffer !== true) {
    return NextResponse.json({ error: "unsupported update" }, { status: 400 });
  }
  if (wizardAgentChosen !== undefined && (typeof wizardAgentChosen !== "string" || !isSetupAgentId(wizardAgentChosen))) {
    return NextResponse.json({ error: "unknown agent" }, { status: 400 });
  }
  if (finished !== undefined && finished !== true) {
    return NextResponse.json({ error: "unsupported update" }, { status: 400 });
  }

  const s = getSettings();
  const now = new Date();
  const patch: Partial<AppSettings> = {};
  if (dismissDemoOffer === true) patch.onboardingDemoDismissedAt = now;
  if (typeof wizardAgentChosen === "string" && !wizardFinished(s)) {
    if (s.agentWizardChosenAt == null) patch.agentWizardChosenAt = now;
    patch.agentWizardAgent = wizardAgentChosen;
  }
  if (finished === true && s.agentWizardFinishedAt == null) patch.agentWizardFinishedAt = now;
  updateSettings(patch);
  return NextResponse.json(onboardingState(getSettings()));
}
