import { it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));

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
