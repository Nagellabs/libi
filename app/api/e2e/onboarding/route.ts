/**
 * E2E-only: forget, and put back, the first-launch onboarding — the persona
 * answer, the Agents tab wizard's recorded pick and finish, and whether an agent
 * ever connected (on its own that counts an install as set up, see the onboarding
 * state route). The first-launch spec forgets them so it sees a first launch
 * however many specs ran before it on the shared scratch DB, and when it finishes
 * writes back what DELETE answered, so the specs after it find the home as it was.
 * The product has no undo for any of these, so it lives with the other test routes.
 *
 * DISABLED by default. Enabled only by `LIBI_ENABLE_TEST_ROUTES=1`, which the
 * e2e runner sets on the libi it spawns.
 */
import { NextResponse } from "next/server";
import { getSettings, updateSettings, type AppSettings } from "@/lib/db/settings";
import { testRoutesEnabled } from "@/lib/security/test-routes";

/** Everything DELETE forgets, as it answers it and as PUT takes it back. Dates are ISO strings. */
interface OnboardingSnapshot {
  onboardingPersona: string | null;
  personaSelectedAt: string | null;
  agentWizardChosenAt: string | null;
  agentWizardAgent: string | null;
  agentWizardFinishedAt: string | null;
  agentEverConnected: boolean;
}

const TEXT_FIELDS = ["onboardingPersona", "agentWizardAgent"] as const;
const DATE_FIELDS = ["personaSelectedAt", "agentWizardChosenAt", "agentWizardFinishedAt"] as const;

function snapshot(s: AppSettings): OnboardingSnapshot {
  return {
    onboardingPersona: s.onboardingPersona,
    personaSelectedAt: s.personaSelectedAt?.toISOString() ?? null,
    agentWizardChosenAt: s.agentWizardChosenAt?.toISOString() ?? null,
    agentWizardAgent: s.agentWizardAgent,
    agentWizardFinishedAt: s.agentWizardFinishedAt?.toISOString() ?? null,
    agentEverConnected: s.agentEverConnected,
  };
}

/** The settings a snapshot writes back, or null when any field is missing or of the wrong type. */
function fromSnapshot(body: unknown): Partial<AppSettings> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};
  for (const key of TEXT_FIELDS) {
    const value = b[key];
    if (value !== null && typeof value !== "string") return null;
    patch[key] = value;
  }
  for (const key of DATE_FIELDS) {
    const value = b[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
    patch[key] = new Date(value);
  }
  if (typeof b.agentEverConnected !== "boolean") return null;
  patch.agentEverConnected = b.agentEverConnected;
  return patch;
}

function disabled(): Response {
  return NextResponse.json({ error: "E2E test routes are disabled in this environment" }, { status: 403 });
}

export async function DELETE(): Promise<Response> {
  if (!testRoutesEnabled()) return disabled();
  const previous = snapshot(getSettings());
  updateSettings({
    onboardingPersona: null,
    personaSelectedAt: null,
    agentWizardChosenAt: null,
    agentWizardAgent: null,
    agentWizardFinishedAt: null,
    agentEverConnected: false,
  });
  return NextResponse.json({ ok: true, previous });
}

/** Writes back the `previous` a DELETE answered. Every field is required, so nothing is put back halfway. */
export async function PUT(request: Request): Promise<Response> {
  if (!testRoutesEnabled()) return disabled();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const patch = fromSnapshot(body);
  if (patch === null) return NextResponse.json({ error: "not an onboarding snapshot" }, { status: 400 });
  updateSettings(patch);
  return NextResponse.json({ ok: true });
}
