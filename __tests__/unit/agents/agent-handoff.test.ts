import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_TTL_MS,
  attachEditorNavigate,
  beginHandoff,
  currentHandoff,
  decideOffEditorNavigate,
  isEditorAttached,
  resetAgentHandoffForTests,
  routeOffEditorNavigate,
  type AgentHandoff,
} from "@/lib/agents/agent-handoff";

/**
 * The rule that decides when an agent `navigate` event may move the user from
 * another page to the editor (lib/agents/agent-handoff.ts). Task 13's
 * walk-through: Use on /templates applied the template, but the navigate event
 * reached no listener, so the user stayed on /templates and the new piece
 * never opened. The fix follows ONLY the hand-off the user just made — these
 * pin that it can never yank a user for anything else.
 */

const NOW = 1_000_000;
const handoff: AgentHandoff = { sessionId: "s-new", fromPath: "/templates", at: NOW - 5_000 };
const base = {
  handoff,
  editorAttached: false,
  pathname: "/templates",
  activeSessionId: "s-new",
  now: NOW,
};
const OPEN = { target: "piece", pieceId: "p-applied" };

describe("decideOffEditorNavigate", () => {
  it("follows the hand-off while the user is still on the page they sent from", () => {
    expect(decideOffEditorNavigate(base)).toBe("follow");
  });

  it("follows it once the redirect has reached /editor but the editor has not attached yet", () => {
    expect(decideOffEditorNavigate({ ...base, pathname: "/editor" })).toBe("follow");
  });

  it("leaves the event to the editor once it has attached", () => {
    expect(decideOffEditorNavigate({ ...base, editorAttached: true })).toBe("ignore");
  });

  it("does nothing without a hand-off — no page is ever left for someone else's event", () => {
    expect(decideOffEditorNavigate({ ...base, handoff: null })).toBe("ignore");
  });

  it("drops the hand-off when the user has switched to another session", () => {
    expect(decideOffEditorNavigate({ ...base, activeSessionId: "s-other" })).toBe("drop-handoff");
  });

  it("drops the hand-off when the user has gone to a different page on their own", () => {
    expect(decideOffEditorNavigate({ ...base, pathname: "/social" })).toBe("drop-handoff");
  });

  it("drops a hand-off older than the TTL", () => {
    expect(decideOffEditorNavigate({ ...base, now: handoff.at + HANDOFF_TTL_MS + 1 })).toBe("drop-handoff");
  });
});

describe("the hand-off store", () => {
  beforeEach(() => resetAgentHandoffForTests());

  it("parks a followed event and hands it to the editor as it attaches, ending the hand-off", () => {
    beginHandoff(handoff);
    expect(routeOffEditorNavigate(OPEN, { pathname: "/templates", activeSessionId: "s-new", now: NOW })).toBe(true);

    const { pending, detach } = attachEditorNavigate();
    expect(pending).toEqual(OPEN);
    expect(currentHandoff()).toBeNull();
    expect(isEditorAttached()).toBe(true);
    // Nothing is replayed twice.
    expect(attachEditorNavigate().pending).toBeNull();
    detach();
  });

  it("keeps the LATEST event when several arrive before the editor attaches", () => {
    beginHandoff(handoff);
    const ctx = { pathname: "/templates", activeSessionId: "s-new", now: NOW };
    routeOffEditorNavigate({ target: "piece", pieceId: "p1" }, ctx);
    routeOffEditorNavigate({ target: "preview", pieceId: "p1" }, ctx);
    expect(attachEditorNavigate().pending).toEqual({ target: "preview", pieceId: "p1" });
  });

  it("ignores every event while the editor is attached, and again after it detaches", () => {
    const { detach } = attachEditorNavigate();
    beginHandoff(handoff);
    expect(routeOffEditorNavigate(OPEN, { pathname: "/templates", activeSessionId: "s-new", now: NOW })).toBe(false);
    detach();
    expect(isEditorAttached()).toBe(false);
    // The hand-off was begun while attached, so it is still live — but an
    // event from another session must still not move anyone.
    expect(routeOffEditorNavigate(OPEN, { pathname: "/templates", activeSessionId: "s-other", now: NOW })).toBe(false);
    expect(currentHandoff()).toBeNull();
    expect(attachEditorNavigate().pending).toBeNull();
  });

  it("parks nothing for an event that arrives with no hand-off", () => {
    expect(routeOffEditorNavigate(OPEN, { pathname: "/social", activeSessionId: "s-new", now: NOW })).toBe(false);
    expect(attachEditorNavigate().pending).toBeNull();
  });
});

/**
 * The editor half is a source scan, like the sibling editor-page-* tests: the
 * navigate listener claims the parked event as it attaches. That a piece-opening
 * event then outranks the "reopen the last piece" restore (and a folder reveal
 * does not) is pinned on the mounted page, in
 * __tests__/unit/components/editor-page-navigate-vs-restore.test.tsx.
 */
describe("editor page — claims a parked navigate as it attaches", () => {
  const source = readFileSync(join(process.cwd(), "app/(app)/editor/page.tsx"), "utf8");

  it("attaches to the hand-off store in the same effect that subscribes to navigate events", () => {
    expect(source).toMatch(
      /const off = navigateEmitter\.on\(handleNavigate\);\s*const \{ pending, detach \} = attachEditorNavigate\(\);\s*if \(pending\) handleNavigate\(pending\);/,
    );
  });
});
