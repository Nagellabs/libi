// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearComposerDraft,
  composerDraftKey,
  draftIsMeaningful,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraft,
} from "@/hooks/social/use-composer-draft";

const KEY = composerDraftKey("p1", null);

function draft(over: Partial<Omit<ComposerDraft, "v" | "savedAt">> = {}) {
  return {
    step: "caption" as const,
    exportPath: "/exports/e.mp4",
    targets: [],
    caption: "hook goes here",
    when: { mode: "draft" as const },
    ...over,
  };
}

describe("composer autosave", () => {
  beforeEach(() => window.localStorage.clear());

  it("keys a new post and an edited draft separately", () => {
    // Editing an existing provider draft and composing a new post are two
    // different pieces of work on the same piece.
    expect(composerDraftKey("p1", null)).not.toBe(composerDraftKey("p1", "post_9"));
  });

  it("round-trips what the user had typed", () => {
    writeComposerDraft(KEY, draft());
    expect(readComposerDraft(KEY)).toMatchObject({ step: "caption", caption: "hook goes here", exportPath: "/exports/e.mp4" });
  });

  it("never restores an armed Publish now", () => {
    // Coming back to a half-finished composer and finding it ready to publish
    // irreversibly is the one restore that could cost something real.
    writeComposerDraft(KEY, draft({ when: { mode: "now" } }));
    expect(readComposerDraft(KEY)?.when).toEqual({ mode: "draft" });
  });

  it("keeps a schedule, which is recoverable", () => {
    writeComposerDraft(KEY, draft({ when: { mode: "schedule", scheduledFor: "2030-01-01T09:00", timezone: "Asia/Bangkok" } }));
    expect(readComposerDraft(KEY)?.when).toEqual({ mode: "schedule", scheduledFor: "2030-01-01T09:00", timezone: "Asia/Bangkok" });
  });

  it("ignores a draft older than a fortnight", () => {
    writeComposerDraft(KEY, draft());
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored, savedAt: "2026-09-01T00:00:00.000Z" }));
    expect(readComposerDraft(KEY, new Date("2026-09-21T00:00:00.000Z").getTime())).toBeNull();
  });

  it("ignores anything it cannot read, rather than throwing into the composer's mount", () => {
    window.localStorage.setItem(KEY, "not json");
    expect(readComposerDraft(KEY)).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ v: 99, targets: [] }));
    expect(readComposerDraft(KEY)).toBeNull();
    expect(readComposerDraft("libi.social.composer:nothing:new")).toBeNull();
  });

  it("clears", () => {
    writeComposerDraft(KEY, draft());
    clearComposerDraft(KEY);
    expect(readComposerDraft(KEY)).toBeNull();
  });

  it("treats an untouched composer as nothing worth keeping", () => {
    // Merely opening the Posting tab must not make a piece look like it has
    // work in progress.
    expect(draftIsMeaningful({ step: "media", exportPath: "/e.mp4", targets: [], caption: "", when: { mode: "draft" } })).toBe(false);
    expect(draftIsMeaningful(draft())).toBe(true);
    expect(draftIsMeaningful({ step: "media", exportPath: null, targets: [], caption: "", when: { mode: "now" } })).toBe(true);
  });
});
