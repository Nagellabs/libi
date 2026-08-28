import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

import { getSettings, updateSettings } from "@/lib/db/settings";

/**
 * Task 13: the demo offer that vanishes on reload.
 *
 * Two distinct facts, stored independently so a dismissal can't be confused
 * with "never offered", and so a reload can recover "was offered, not yet
 * resolved" from the DB instead of a client-only `useState(false)`:
 *   - onboardingDemoOfferedAt   — set once, server-side, on first agent connect
 *   - onboardingDemoDismissedAt — set once the user dismisses OR takes the offer
 */
describe("onboarding demo offer settings", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("defaults to never offered, never dismissed", () => {
    const s = getSettings();
    expect(s.onboardingDemoOfferedAt).toBeNull();
    expect(s.onboardingDemoDismissedAt).toBeNull();
  });

  it("round-trips onboardingDemoOfferedAt", () => {
    // SQLite integer timestamps store seconds, not milliseconds — truncate
    // to avoid a sub-second mismatch, same as the existing persona test.
    const when = new Date(Math.floor(Date.now() / 1000) * 1000);
    updateSettings({ onboardingDemoOfferedAt: when });

    const s = getSettings();
    expect(s.onboardingDemoOfferedAt?.getTime()).toBe(when.getTime());
    expect(s.onboardingDemoDismissedAt).toBeNull();
  });

  it("round-trips onboardingDemoDismissedAt independently of onboardingDemoOfferedAt", () => {
    const offered = new Date(Math.floor(Date.now() / 1000) * 1000);
    updateSettings({ onboardingDemoOfferedAt: offered });

    const dismissed = new Date(offered.getTime() + 60_000);
    updateSettings({ onboardingDemoDismissedAt: dismissed });

    const s = getSettings();
    expect(s.onboardingDemoOfferedAt?.getTime()).toBe(offered.getTime());
    expect(s.onboardingDemoDismissedAt?.getTime()).toBe(dismissed.getTime());
  });

  it("creates the row if it doesn't exist yet", () => {
    const when = new Date(Math.floor(Date.now() / 1000) * 1000);
    updateSettings({ onboardingDemoOfferedAt: when });
    expect(getSettings().onboardingDemoOfferedAt?.getTime()).toBe(when.getTime());
  });
});
