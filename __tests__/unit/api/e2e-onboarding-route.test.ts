import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

const routes = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/security/test-routes", () => ({ testRoutesEnabled: () => routes.enabled }));

import { DELETE, PUT } from "@/app/api/e2e/onboarding/route";
import { getSettings, updateSettings } from "@/lib/db/settings";

/**
 * The e2e-only undo of the first-launch onboarding. The first-launch spec forgets
 * it so it sees a first launch however many specs answered it before, and writes
 * back what it found when it finishes, so the specs after it find the home as it was.
 */
describe("/api/e2e/onboarding", () => {
  beforeEach(() => {
    createTestDb();
    routes.enabled = true;
  });

  function answerOnboarding() {
    updateSettings({
      onboardingPersona: "developer",
      personaSelectedAt: new Date("2026-09-10T08:00:00.000Z"),
      agentWizardChosenAt: new Date("2026-09-11T09:00:00.000Z"),
      agentWizardAgent: "codex",
      agentWizardFinishedAt: new Date("2026-09-12T10:00:00.000Z"),
      agentEverConnected: true,
      onboardingDemoDismissedAt: new Date(),
      claudeSignInConfirmedAt: new Date(),
    });
  }

  function putBack(body: unknown) {
    return PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }));
  }

  it("DELETE forgets the persona answer, the wizard's pick and finish, and that an agent ever connected — and nothing else", async () => {
    answerOnboarding();
    const res = await DELETE();
    expect(res.status).toBe(200);
    const s = getSettings();
    expect(s).toMatchObject({
      onboardingPersona: null,
      personaSelectedAt: null,
      agentWizardChosenAt: null,
      agentWizardAgent: null,
      agentWizardFinishedAt: null,
      agentEverConnected: false,
    });
    expect(s.onboardingDemoDismissedAt).not.toBeNull();
    expect(s.claudeSignInConfirmedAt).not.toBeNull();
  });

  it("DELETE answers with what it forgot, and PUT writes exactly that back", async () => {
    answerOnboarding();
    const { previous } = await (await DELETE()).json();
    expect(previous).toEqual({
      onboardingPersona: "developer",
      personaSelectedAt: "2026-09-10T08:00:00.000Z",
      agentWizardChosenAt: "2026-09-11T09:00:00.000Z",
      agentWizardAgent: "codex",
      agentWizardFinishedAt: "2026-09-12T10:00:00.000Z",
      agentEverConnected: true,
    });

    expect((await putBack(previous)).status).toBe(200);
    const s = getSettings();
    expect(s).toMatchObject({ onboardingPersona: "developer", agentWizardAgent: "codex", agentEverConnected: true });
    expect(s.personaSelectedAt?.toISOString()).toBe("2026-09-10T08:00:00.000Z");
    expect(s.agentWizardChosenAt?.toISOString()).toBe("2026-09-11T09:00:00.000Z");
    expect(s.agentWizardFinishedAt?.toISOString()).toBe("2026-09-12T10:00:00.000Z");
  });

  it("PUT puts back a first launch just as faithfully as a finished one", async () => {
    const { previous } = await (await DELETE()).json();
    answerOnboarding();
    expect((await putBack(previous)).status).toBe(200);
    expect(getSettings()).toMatchObject({
      onboardingPersona: null,
      personaSelectedAt: null,
      agentWizardChosenAt: null,
      agentWizardAgent: null,
      agentWizardFinishedAt: null,
      agentEverConnected: false,
    });
  });

  it("PUT refuses a snapshot with a field missing or of the wrong type, and writes nothing", async () => {
    const { previous } = await (await DELETE()).json();
    const bad: unknown[] = [
      { ...previous, agentEverConnected: "yes" },
      { ...previous, personaSelectedAt: "not a date" },
      { ...previous, onboardingPersona: 42 },
      { onboardingPersona: "developer" },
      [],
      null,
    ];
    for (const body of bad) {
      expect((await putBack(body)).status).toBe(400);
    }
    expect(getSettings().onboardingPersona).toBeNull();
    expect((await PUT(new Request("http://x", { method: "PUT", body: "not-json" }))).status).toBe(400);
  });

  it("both are refused, and change nothing, unless test routes are enabled", async () => {
    answerOnboarding();
    const { previous } = await (await DELETE()).json();
    routes.enabled = false;
    answerOnboarding();
    expect((await DELETE()).status).toBe(403);
    expect(getSettings().personaSelectedAt).not.toBeNull();
    expect(getSettings().agentEverConnected).toBe(true);
    expect((await putBack({ ...previous, onboardingPersona: null })).status).toBe(403);
    expect(getSettings().onboardingPersona).toBe("developer");
  });
});
