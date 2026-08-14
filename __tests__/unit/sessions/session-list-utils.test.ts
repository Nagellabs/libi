import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  emptySessionsMessage,
  formatSessionDate,
} from "@/components/sessions/session-list-utils";

// ---------------------------------------------------------------------------
// emptySessionsMessage
//
// The empty-state copy differs by whether the active agent can list past
// sessions. claude-code (canListSessions:true) keeps "No sessions yet"; codex
// (false) gets an honest "doesn't expose past sessions" message.
// ---------------------------------------------------------------------------

describe("emptySessionsMessage", () => {
  it("returns the bare copy when the agent can list sessions", () => {
    expect(emptySessionsMessage(true, "Claude Code")).toBe("No sessions yet");
    // Agent name is irrelevant when history is available.
    expect(emptySessionsMessage(true)).toBe("No sessions yet");
  });

  it("returns an honest message when the agent can't list sessions", () => {
    const msg = emptySessionsMessage(false, "Codex");
    expect(msg).toBe(
      "Codex doesn't expose past sessions — new chats appear here for this run.",
    );
  });

  it("falls back to a generic subject when no agent name is available", () => {
    expect(emptySessionsMessage(false)).toBe(
      "This agent doesn't expose past sessions — new chats appear here for this run.",
    );
    expect(emptySessionsMessage(false, "  ")).toBe(
      "This agent doesn't expose past sessions — new chats appear here for this run.",
    );
  });

  it("differs by canListSessions for the same agent", () => {
    expect(emptySessionsMessage(true, "Codex")).not.toBe(
      emptySessionsMessage(false, "Codex"),
    );
  });
});

// ---------------------------------------------------------------------------
// formatSessionDate
//
// Returns a time string for today's dates and a short date for older dates.
// ---------------------------------------------------------------------------

describe("formatSessionDate", () => {
  beforeEach(() => {
    // Pin "now" to 2026-04-18T15:30:00 local time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 15, 30, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for null", () => {
    expect(formatSessionDate(null)).toBe("");
  });

  it("returns a time string for a date today", () => {
    // Today at 10:15 AM
    const todayAt10 = new Date(2026, 3, 18, 10, 15, 0).toISOString();
    const result = formatSessionDate(todayAt10);

    // Should contain the time, not the date
    expect(result).toMatch(/10/);
    expect(result).toMatch(/15/);
    // Should NOT contain month or day abbreviation
    expect(result).not.toMatch(/Apr/);
  });

  it("returns a short date string for yesterday", () => {
    const yesterday = new Date(2026, 3, 17, 14, 0, 0).toISOString();
    const result = formatSessionDate(yesterday);

    // Should contain the month and day (Apr 17)
    expect(result).toMatch(/Apr/);
    expect(result).toMatch(/17/);
  });

  it("returns a short date string for an older date", () => {
    const older = new Date(2026, 2, 5, 9, 0, 0).toISOString();
    const result = formatSessionDate(older);

    // Should contain Mar 5
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/5/);
  });
});
