import { it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
// Wrap the real updateSettings in a spy (rather than replacing it) so the
// persona-write tests below can still assert it actually persisted, while
// also pinning WHEN it's called relative to analytics.
vi.mock("@/lib/db/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/settings")>();
  return { ...actual, updateSettings: vi.fn(actual.updateSettings) };
});

beforeEach(() => {
  testDb = createTestDb();
  vi.clearAllMocks();
});

it("GET state defaults to needsPersona + needsOnboarding", async () => {
  const { GET } = await import("@/app/api/onboarding/state/route");
  const res = await GET();
  const json = await res.json();
  expect(json).toMatchObject({ needsPersona: true, needsOnboarding: true });
});

it("PUT persona records it + flips needsPersona", async () => {
  const { PUT } = await import("@/app/api/onboarding/persona/route");
  const { trackServerEvent } = await import("@/lib/analytics/server");
  const res = await PUT(
    new Request("http://x", { method: "PUT", body: JSON.stringify({ persona: "agency" }) }),
  );
  expect(res.status).toBe(200);
  expect(trackServerEvent).toHaveBeenCalledWith("persona_selected", { persona: "agency" });

  const { GET } = await import("@/app/api/onboarding/state/route");
  const json = await (await GET()).json();
  expect(json.needsPersona).toBe(false);
  expect(json.persona).toBe("agency");
});

it("PUT persona rejects an unknown persona", async () => {
  const { PUT } = await import("@/app/api/onboarding/persona/route");
  const res = await PUT(
    new Request("http://x", { method: "PUT", body: JSON.stringify({ persona: "wizard" }) }),
  );
  expect(res.status).toBe(400);
});

it("PUT persona rejects malformed JSON", async () => {
  const { PUT } = await import("@/app/api/onboarding/persona/route");
  const res = await PUT(new Request("http://x", { method: "PUT", body: "not-json" }));
  expect(res.status).toBe(400);
});

/**
 * Task 13: the demo offer that vanishes on reload.
 *
 * `GET /api/onboarding/state` now reports `demoOffered`, computed from two
 * DB timestamps rather than a client `useState(false)`. This is the test
 * that reproduces the original bug: arm the offer (simulating the
 * server-side arm on first agent connect — session-manager's
 * `markAgentConnected`), then read state again with a FRESH `GET` — i.e. no
 * client action in between — the way a page reload would. Before this
 * route reported `demoOffered`, this assertion could not even be made: the
 * offer lived only in React state and a reload always lost it.
 */
it("GET reports demoOffered — still true on a fresh GET, i.e. survives a reload", async () => {
  const { updateSettings } = await import("@/lib/db/settings");
  const { GET } = await import("@/app/api/onboarding/state/route");

  let json = await (await GET()).json();
  expect(json.demoOffered).toBe(false);

  // Simulates lib/sessions/session-manager.ts#markAgentConnected arming the
  // offer server-side on first connect.
  updateSettings({ onboardingDemoOfferedAt: new Date() });

  json = await (await GET()).json();
  expect(json.demoOffered).toBe(true);
});

it("PUT dismissDemoOffer persists — the offer never returns, even after a reconnect", async () => {
  const { updateSettings } = await import("@/lib/db/settings");
  const { GET } = await import("@/app/api/onboarding/state/route");
  const { PUT } = await import("@/app/api/onboarding/state/route");

  updateSettings({ onboardingDemoOfferedAt: new Date() });
  const res = await PUT(
    new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ dismissDemoOffer: true }),
    }),
  );
  expect(res.status).toBe(200);

  let json = await (await GET()).json();
  expect(json.demoOffered).toBe(false);

  // A later re-arm (e.g. a reconnect) must not resurrect a dismissed offer —
  // the dismissal is the final word, independent of the offered timestamp.
  updateSettings({ onboardingDemoOfferedAt: new Date() });
  json = await (await GET()).json();
  expect(json.demoOffered).toBe(false);
});

it("PUT rejects a body without dismissDemoOffer: true", async () => {
  const { PUT } = await import("@/app/api/onboarding/state/route");
  const res = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({}) }));
  expect(res.status).toBe(400);
});

it("PUT rejects malformed JSON", async () => {
  const { PUT } = await import("@/app/api/onboarding/state/route");
  const res = await PUT(new Request("http://x", { method: "PUT", body: "not-json" }));
  expect(res.status).toBe(400);
});

/**
 * The Agents tab's setup wizard records two things about itself: when an agent
 * was first picked (and which agent is being set up), and when the wizard first
 * reached its end. Neither recorded is a first onboarding — the wizard alone.
 */
function put(body: unknown) {
  return import("@/app/api/onboarding/state/route").then(({ PUT }) =>
    PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) })),
  );
}
async function state() {
  const { GET } = await import("@/app/api/onboarding/state/route");
  return (await GET()).json();
}

it("GET reports a first onboarding by default: no agent chosen, the wizard not finished", async () => {
  expect(await state()).toMatchObject({
    wizardAgentChosenAt: null,
    wizardAgent: null,
    wizardFinishedAt: null,
    wizardFinished: false,
  });
});

it("PUT wizardAgentChosen keeps the first pick's time and follows the latest pick", async () => {
  expect((await put({ wizardAgentChosen: "claude-code" })).status).toBe(200);
  const first = await state();
  expect(first.wizardAgent).toBe("claude-code");
  expect(typeof first.wizardAgentChosenAt).toBe("string");
  expect(first.wizardFinished).toBe(false);

  expect((await put({ wizardAgentChosen: "codex" })).status).toBe(200);
  const second = await state();
  expect(second.wizardAgent).toBe("codex");
  expect(second.wizardAgentChosenAt).toBe(first.wizardAgentChosenAt);
});

it("PUT wizardFinished keeps the first time the wizard reached its end, and a pick after it changes nothing", async () => {
  await put({ wizardAgentChosen: "codex" });
  expect((await put({ wizardFinished: true })).status).toBe(200);
  const finished = await state();
  expect(finished.wizardFinished).toBe(true);
  expect(typeof finished.wizardFinishedAt).toBe("string");

  expect((await put({ wizardFinished: true })).status).toBe(200);
  expect((await put({ wizardAgentChosen: "claude-code" })).status).toBe(200);
  const after = await state();
  expect(after.wizardFinishedAt).toBe(finished.wizardFinishedAt);
  expect(after.wizardAgent).toBe("codex");
  expect(after.wizardAgentChosenAt).toBe(finished.wizardAgentChosenAt);
});

it("PUT rejects an agent id that isn't a setup agent, and writes nothing else from that body", async () => {
  const { updateSettings } = await import("@/lib/db/settings");
  updateSettings({ onboardingDemoOfferedAt: new Date() });
  for (const wizardAgentChosen of ["wizard", "terminal", "", 42, null]) {
    expect((await put({ wizardAgentChosen })).status).toBe(400);
  }
  expect((await put({ dismissDemoOffer: true, wizardAgentChosen: "gemini" })).status).toBe(400);
  const json = await state();
  expect(json.wizardAgent).toBeNull();
  expect(json.wizardAgentChosenAt).toBeNull();
  expect(json.demoOffered).toBe(true);
});

it("PUT rejects wizardFinished that isn't true, and a body that isn't an object", async () => {
  for (const wizardFinished of [false, "yes", 1, null]) {
    expect((await put({ wizardFinished })).status).toBe(400);
  }
  expect((await put(["wizardFinished"])).status).toBe(400);
  expect((await put(null)).status).toBe(400);
  expect((await state()).wizardFinishedAt).toBeNull();
});

it("an install whose agent connected before the wizard recorded anything counts as finished, and stays so after a pick", async () => {
  const { updateSettings } = await import("@/lib/db/settings");
  updateSettings({ agentEverConnected: true });
  expect((await state()).wizardFinished).toBe(true);
  await put({ wizardAgentChosen: "codex" });
  const json = await state();
  expect(json.wizardFinished).toBe(true);
  expect(json.wizardAgentChosenAt).toBeNull();
});

it("PUT answers with the onboarding state as it now stands, in the shape GET reports", async () => {
  const res = await put({ wizardAgentChosen: "codex" });
  expect(res.status).toBe(200);
  const answer = await res.json();
  expect(answer).toEqual(await state());
  expect(answer).toMatchObject({ needsPersona: true, wizardAgent: "codex", wizardFinished: false });
  expect(typeof answer.wizardAgentChosenAt).toBe("string");
});

it("an agent connecting after the pick does not finish a first onboarding", async () => {
  const { updateSettings } = await import("@/lib/db/settings");
  await put({ wizardAgentChosen: "claude-code" });
  // session-manager's markAgentConnected fires as soon as the download lets a standby session start.
  updateSettings({ agentEverConnected: true });
  expect((await state()).wizardFinished).toBe(false);
});

/**
 * Task 12 pin: the persona write must not depend on analytics. `updateSettings`
 * runs first and `trackServerEvent` fires after — as a synchronous, un-awaited,
 * cannot-throw enqueue (lib/analytics/server.ts). These two tests fail loudly
 * if a future change makes the save wait on analytics, in either sense of
 * "wait": calling it first, or awaiting its result.
 */
it("writes the persona to settings before firing analytics (not after, not instead)", async () => {
  const { PUT } = await import("@/app/api/onboarding/persona/route");
  const { updateSettings } = await import("@/lib/db/settings");
  const { trackServerEvent } = await import("@/lib/analytics/server");

  const res = await PUT(
    new Request("http://x", { method: "PUT", body: JSON.stringify({ persona: "agency" }) }),
  );

  expect(res.status).toBe(200);
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ onboardingPersona: "agency" }),
  );
  const dbOrder = vi.mocked(updateSettings).mock.invocationCallOrder[0];
  const analyticsOrder = vi.mocked(trackServerEvent).mock.invocationCallOrder[0];
  expect(dbOrder).toBeLessThan(analyticsOrder);
});

it("does not await analytics — the save resolves even if analytics never settles", async () => {
  const { trackServerEvent } = await import("@/lib/analytics/server");
  // A hypothetical future trackServerEvent that returns a promise which never
  // resolves. Production code can never actually do this — trackServerEvent
  // is deliberately `void`, not `Promise<void>` — but the route must not
  // `await` it regardless, so this simulates the regression this test guards.
  vi.mocked(trackServerEvent).mockImplementation(
    (() => new Promise(() => {})) as unknown as typeof trackServerEvent,
  );

  const { PUT } = await import("@/app/api/onboarding/persona/route");
  const TIMEOUT = Symbol("timeout");
  const result = await Promise.race([
    PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ persona: "curious" }) })),
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 200)),
  ]);

  expect(result).not.toBe(TIMEOUT);
  expect((result as Response).status).toBe(200);
});
