// @vitest-environment jsdom
/**
 * Per-session composer drafts (lib/chat/draft-store.ts) — what keeps a typed
 * or failed-to-send message from vanishing on a page reload. The store is
 * deliberately dumb (sessionStorage + a prefix); the interesting semantics
 * are the two failure-path helpers:
 *
 *   - `backupFailedSend` fills only an EMPTY slot (newer typing wins), and
 *   - `clearBackupOnDelivery` removes only a MATCHING backup (a successful
 *     retry must not clobber a draft typed since the failure).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDraft,
  saveDraft,
  backupFailedSend,
  clearBackupOnDelivery,
} from "@/lib/chat/draft-store";

const SID = "sess-a";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("draft-store", () => {
  it("round-trips a draft per session and isolates sessions", () => {
    saveDraft(SID, "hello");
    saveDraft("sess-b", "other");
    expect(loadDraft(SID)).toBe("hello");
    expect(loadDraft("sess-b")).toBe("other");
  });

  it("returns empty string when nothing is stored", () => {
    expect(loadDraft(SID)).toBe("");
  });

  it("saving an empty value removes the entry", () => {
    saveDraft(SID, "hello");
    saveDraft(SID, "");
    expect(loadDraft(SID)).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("no-ops on a null sessionId", () => {
    saveDraft(null, "hello");
    expect(loadDraft(null)).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("backupFailedSend persists the failed text into an empty slot", () => {
    backupFailedSend(SID, "precious words");
    expect(loadDraft(SID)).toBe("precious words");
  });

  it("backupFailedSend never clobbers newer typing", () => {
    saveDraft(SID, "newer draft the user typed after submitting");
    backupFailedSend(SID, "older failed send");
    expect(loadDraft(SID)).toBe("newer draft the user typed after submitting");
  });

  it("clearBackupOnDelivery removes a matching backup (successful retry)", () => {
    backupFailedSend(SID, "precious words");
    clearBackupOnDelivery(SID, "precious words");
    expect(loadDraft(SID)).toBe("");
  });

  it("clearBackupOnDelivery leaves a non-matching draft alone", () => {
    saveDraft(SID, "something newer");
    clearBackupOnDelivery(SID, "precious words");
    expect(loadDraft(SID)).toBe("something newer");
  });
});
