/**
 * Which studio tab obeys an agent's "show" navigation (`libi.show_extension`,
 * `libi.show_templates`, `libi.start_onboarding` → `navigate_agents` / `navigate_templates`).
 *
 * The event reaches EVERY open tab over its SSE connection, and every tab used to obey — so a tab
 * the user had parked on another page was yanked away by a chat running in a different tab
 * (full-verification F14). The server now names the chat the call came from (`fromSessionId`,
 * resolved from the tool call; `lib/sessions/session-manager.ts#sessionForToolCall`) and a
 * per-event `navId`:
 *
 *  - no `fromSessionId` (a CLI agent via `libi connect`, whose calls belong to no libi chat, or an
 *    older server): every tab obeys, as before;
 *  - the chat is THIS tab's active chat (`sessionList.activeSessionId`, kept by the always-mounted
 *    `EditorStateProvider` — not whether a chat panel is mounted, which is only on /editor, so a
 *    second `show_*` after the first moved the tab would find no owner; review M1): this tab obeys
 *    at once, and tells the other tabs so over a BroadcastChannel;
 *  - otherwise this tab waits `waitMs` for that claim, and obeys only if no tab claimed it — the
 *    chat may be running with no tab showing it (the user is on Settings), and then today's
 *    behaviour (navigate) is kept.
 */

export interface TabNavEvent {
  fromSessionId?: unknown;
  navId?: unknown;
}

/** The slice of BroadcastChannel the gate uses (injectable for tests). */
export interface TabNavChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface TabNavGateDeps {
  /** Whether `sessionId` is the chat this tab has selected. */
  isThisTabsChat: (sessionId: string) => boolean;
  /** Null where BroadcastChannel does not exist: the tab then can't hear a claim and obeys after
   *  the wait, which is today's behaviour. */
  channel: TabNavChannel | null;
  waitMs?: number;
}

export const TAB_NAV_CLAIM_WAIT_MS = 400;
export const TAB_NAV_CHANNEL = "libi-tab-nav";
/** Claims remembered at most; the oldest go first. A claim is only ever needed for `waitMs`. */
const MAX_CLAIMS = 64;

export type TabNavGate = (event: TabNavEvent, go: () => void) => void;

export function createTabNavGate(deps: TabNavGateDeps): TabNavGate {
  const waitMs = deps.waitMs ?? TAB_NAV_CLAIM_WAIT_MS;
  const claimed: string[] = [];
  if (deps.channel) {
    deps.channel.onmessage = (e) => {
      const data = e.data as { type?: unknown; navId?: unknown } | null;
      if (data?.type !== "claimed" || typeof data.navId !== "string") return;
      claimed.push(data.navId);
      if (claimed.length > MAX_CLAIMS) claimed.shift();
    };
  }
  return (event, go) => {
    const from = typeof event.fromSessionId === "string" && event.fromSessionId ? event.fromSessionId : null;
    const navId = typeof event.navId === "string" && event.navId ? event.navId : null;
    if (!from || !navId) {
      go();
      return;
    }
    if (deps.isThisTabsChat(from)) {
      try {
        deps.channel?.postMessage({ type: "claimed", navId });
      } catch {
        // A closed channel only means the other tabs fall back to the wait.
      }
      go();
      return;
    }
    setTimeout(() => {
      if (!claimed.includes(navId)) go();
    }, waitMs);
  };
}

let tabGate: TabNavGate | null = null;
let tabChatCheck: (sessionId: string) => boolean = () => false;

/** This tab's gate, over a real BroadcastChannel. `isThisTabsChat` is the latest the provider
 *  handed in; the gate reads it on each event. */
export function getTabNavGate(isThisTabsChat: (sessionId: string) => boolean): TabNavGate {
  tabChatCheck = isThisTabsChat;
  if (tabGate) return tabGate;
  let channel: TabNavChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(TAB_NAV_CHANNEL) as unknown as TabNavChannel;
    }
  } catch {
    channel = null;
  }
  tabGate = createTabNavGate({ isThisTabsChat: (id) => tabChatCheck(id), channel });
  return tabGate;
}
