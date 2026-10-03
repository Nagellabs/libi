/**
 * Following a prompt the user handed to the agent from a page with no chat.
 *
 * The chat, and the only listener for the agent's `navigate` events
 * (libi.show with target piece / preview, apply_template …), live on `/editor`. The
 * Templates page's Use and the Social page's Ask-the-agent send a prompt from
 * elsewhere, so `useDispatchToAgent` routes to `/editor` right after a
 * successful send. The editor then usually mounts long before the agent's
 * first tool call — but not always (a cold dev compile, the first-launch gate),
 * and a navigate event that reaches no listener is simply lost.
 *
 * This module closes that gap. The layout-level follower
 * (`hooks/agent/use-agent-handoff-follow.ts`) asks `decideOffEditorNavigate`
 * about every navigate event; on "follow" it parks the event here and makes
 * sure the user is headed to `/editor`, and the editor applies the parked
 * event as it attaches.
 *
 * THE RULE. A navigate event moves the user to the editor from another page
 * only while a hand-off the user just made is still in flight:
 *   - the user sent a prompt from THIS tab (a hand-off exists), less than
 *     `HANDOFF_TTL_MS` ago;
 *   - the session it went to is still the one selected in the sidebar;
 *   - the user is still on the page they sent it from, or already on
 *     `/editor` (where the redirect was taking them);
 *   - the editor has not attached yet (once it has, it handles events itself
 *     and the hand-off is over).
 * Anything else is ignored, exactly as before this existed — the user is
 * never pulled off a page they chose. Navigate events carry no session id,
 * so "belongs to that session" is enforced by those conditions: the window
 * is the few seconds between Send and the editor mounting, for the session
 * the user is looking at.
 */

export interface AgentNavigateEvent {
  target: string;
  pieceId: string;
  fileId?: string;
  id?: string;
}

export interface AgentHandoff {
  /** The session the prompt was dispatched to. */
  sessionId: string;
  /** The pathname the user sent it from. */
  fromPath: string;
  /** `Date.now()` at the send. */
  at: number;
}

/** How long a hand-off may wait for the editor. Generous: a cold dev compile of
 *  /editor has taken tens of seconds; the agent's first tool call often takes
 *  longer than that anyway. */
export const HANDOFF_TTL_MS = 2 * 60_000;

export const EDITOR_PATH = "/editor";

export type OffEditorDecision =
  /** Park the event for the editor and make sure the user is on /editor. */
  | "follow"
  /** Not ours to act on; leave everything as it is. */
  | "ignore"
  /** The hand-off is stale or abandoned: forget it, and ignore the event. */
  | "drop-handoff";

export function decideOffEditorNavigate(args: {
  handoff: AgentHandoff | null;
  editorAttached: boolean;
  pathname: string;
  activeSessionId: string | null;
  now: number;
}): OffEditorDecision {
  const { handoff, editorAttached, pathname, activeSessionId, now } = args;
  if (editorAttached) return "ignore";
  if (!handoff) return "ignore";
  if (now - handoff.at > HANDOFF_TTL_MS) return "drop-handoff";
  if (activeSessionId !== handoff.sessionId) return "drop-handoff";
  if (pathname !== handoff.fromPath && pathname !== EDITOR_PATH) return "drop-handoff";
  return "follow";
}

// ── The per-tab store ───────────────────────────────────────────────
// Module state, pinned on globalThis like the SSE emitters so a hot reload in
// dev keeps one copy.

interface HandoffState {
  handoff: AgentHandoff | null;
  pending: AgentNavigateEvent | null;
  editorAttachments: number;
}

const g = globalThis as unknown as { __libiAgentHandoff?: HandoffState };
function state(): HandoffState {
  if (!g.__libiAgentHandoff) g.__libiAgentHandoff = { handoff: null, pending: null, editorAttachments: 0 };
  return g.__libiAgentHandoff;
}

/** Record a hand-off: called by the dispatch hook right after a successful send
 *  from a page other than /editor. A newer hand-off replaces an older one. */
export function beginHandoff(handoff: AgentHandoff): void {
  const s = state();
  s.handoff = handoff;
  s.pending = null;
}

export function currentHandoff(): AgentHandoff | null {
  return state().handoff;
}

export function isEditorAttached(): boolean {
  return state().editorAttachments > 0;
}

/**
 * Apply the rule to one event and do the bookkeeping. Returns true when the
 * caller must take the user to /editor (the event is parked for it).
 */
export function routeOffEditorNavigate(
  event: AgentNavigateEvent,
  ctx: { pathname: string; activeSessionId: string | null; now: number },
): boolean {
  const s = state();
  const decision = decideOffEditorNavigate({
    handoff: s.handoff,
    editorAttached: s.editorAttachments > 0,
    ...ctx,
  });
  if (decision === "drop-handoff") {
    s.handoff = null;
    s.pending = null;
    return false;
  }
  if (decision !== "follow") return false;
  // The latest wins: show(piece) then show(preview) should land on the preview.
  s.pending = event;
  return true;
}

/**
 * The editor's navigate listener attaching. Ends any hand-off (from now on the
 * editor handles events itself) and hands back the event parked for it, if
 * any. Call `detach` when the listener goes.
 */
export function attachEditorNavigate(): { pending: AgentNavigateEvent | null; detach: () => void } {
  const s = state();
  s.editorAttachments += 1;
  const pending = s.pending;
  s.pending = null;
  s.handoff = null;
  let detached = false;
  return {
    pending,
    detach: () => {
      if (detached) return;
      detached = true;
      s.editorAttachments = Math.max(0, s.editorAttachments - 1);
    },
  };
}

/** Test seam: forget everything. */
export function resetAgentHandoffForTests(): void {
  g.__libiAgentHandoff = { handoff: null, pending: null, editorAttachments: 0 };
}
