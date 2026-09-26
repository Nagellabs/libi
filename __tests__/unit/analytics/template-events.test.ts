import { describe, it, expect } from "vitest";
import { EVENT_NAMES, isEventName } from "@/lib/analytics/events";

describe("template analytics events", () => {
  it("are on the allow-list", () => {
    for (const n of [
      "template_created",
      "template_applied",
      "template_deleted",
      // Public catalog (sub-project 3).
      "template_published",
      // The publish funnel: an agent prepares, only the user publishes.
      "template_publish_requested",
      "template_publish_confirmed",
      "template_publish_discarded",
      "template_installed",
      "template_reported",
    ]) {
      expect(EVENT_NAMES).toContain(n);
      expect(isEventName(n)).toBe(true);
    }
  });
});
