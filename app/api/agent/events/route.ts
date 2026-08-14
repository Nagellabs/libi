import { getSessionManager } from "@/lib/sessions/session-manager";
import type { AgentEvent } from "@/lib/agents/types";
import type { SystemEvent } from "@/lib/sessions/types";
import {
  navigationEmitter,
  type NavigateEvent,
  type RefreshQueryEvent,
  type RightRegionEvent,
  type NavigateSettingsEvent,
  type OverlayErrorEvent,
  type HighlightEvent,
  type HighlightEffectEvent,
  type SetComplexityModeEvent,
} from "@/lib/navigation-events";

/** Idle keep-alive interval for the SSE stream. */
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const sm = getSessionManager();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  let globalRef: ((sessionId: string, event: AgentEvent) => void) | null = null;
  let navHandlerRef: ((event: NavigateEvent) => void) | null = null;
  let refreshHandlerRef: ((event: RefreshQueryEvent) => void) | null = null;
  let systemHandlerRef: ((event: SystemEvent) => void) | null = null;
  let rightRegionHandlerRef: ((e: RightRegionEvent) => void) | null = null;
  let navSettingsHandlerRef: ((e: NavigateSettingsEvent) => void) | null = null;
  let overlayErrorHandlerRef: ((e: OverlayErrorEvent) => void) | null = null;
  let highlightHandlerRef: ((e: HighlightEvent) => void) | null = null;
  let highlightEffectHandlerRef: ((e: HighlightEffectEvent) => void) | null = null;
  let setComplexityModeHandlerRef: ((e: SetComplexityModeEvent) => void) | null = null;

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (globalRef) sm.offGlobalEvent(globalRef);
    if (navHandlerRef) navigationEmitter.off("navigate", navHandlerRef);
    if (refreshHandlerRef)
      navigationEmitter.off("refresh_query", refreshHandlerRef);
    if (systemHandlerRef) sm.offSystemEvent(systemHandlerRef);
    if (rightRegionHandlerRef) navigationEmitter.off("right_region", rightRegionHandlerRef);
    if (navSettingsHandlerRef)
      navigationEmitter.off("navigate_settings", navSettingsHandlerRef);
    if (overlayErrorHandlerRef)
      navigationEmitter.off("overlay_error", overlayErrorHandlerRef);
    if (highlightHandlerRef) navigationEmitter.off("highlight", highlightHandlerRef);
    if (highlightEffectHandlerRef)
      navigationEmitter.off("highlight_effect", highlightEffectHandlerRef);
    if (setComplexityModeHandlerRef)
      navigationEmitter.off("set_complexity_mode", setComplexityModeHandlerRef);
  };

  const stream = new ReadableStream({
    start(controller) {
      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
      const encoder = new TextEncoder();

      const send = (sessionId: string, event: AgentEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ ...event, sessionId })}\n\n`
            )
          );
        } catch {
          if (globalRef) sm.offGlobalEvent(globalRef);
        }
      };

      globalRef = send;
      sm.onGlobalEvent(send);

      const navHandler = (event: NavigateEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "navigate", ...event })}\n\n`
            )
          );
        } catch {
          navigationEmitter.off("navigate", navHandler);
        }
      };
      navHandlerRef = navHandler;
      navigationEmitter.on("navigate", navHandler);

      const refreshHandler = (event: RefreshQueryEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "refresh_query", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("refresh_query", refreshHandler);
        }
      };
      refreshHandlerRef = refreshHandler;
      navigationEmitter.on("refresh_query", refreshHandler);

      const rightRegionHandler = (event: RightRegionEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "right_region", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("right_region", rightRegionHandler);
        }
      };
      rightRegionHandlerRef = rightRegionHandler;
      navigationEmitter.on("right_region", rightRegionHandler);

      const navSettingsHandler = (event: NavigateSettingsEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "navigate_settings", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("navigate_settings", navSettingsHandler);
        }
      };
      navSettingsHandlerRef = navSettingsHandler;
      navigationEmitter.on("navigate_settings", navSettingsHandler);

      const overlayErrorHandler = (event: OverlayErrorEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "overlay_error", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("overlay_error", overlayErrorHandler);
        }
      };
      overlayErrorHandlerRef = overlayErrorHandler;
      navigationEmitter.on("overlay_error", overlayErrorHandler);

      const highlightHandler = (event: HighlightEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "highlight", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("highlight", highlightHandler);
        }
      };
      highlightHandlerRef = highlightHandler;
      navigationEmitter.on("highlight", highlightHandler);

      const highlightEffectHandler = (event: HighlightEffectEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "highlight_effect", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("highlight_effect", highlightEffectHandler);
        }
      };
      highlightEffectHandlerRef = highlightEffectHandler;
      navigationEmitter.on("highlight_effect", highlightEffectHandler);

      const setComplexityModeHandler = (event: SetComplexityModeEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "set_complexity_mode", ...event })}\n\n`,
            ),
          );
        } catch {
          navigationEmitter.off("set_complexity_mode", setComplexityModeHandler);
        }
      };
      setComplexityModeHandlerRef = setComplexityModeHandler;
      navigationEmitter.on("set_complexity_mode", setComplexityModeHandler);

      const systemHandler = (event: SystemEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          if (systemHandlerRef) sm.offSystemEvent(systemHandlerRef);
        }
      };
      systemHandlerRef = systemHandler;
      sm.onSystemEvent(systemHandler);

      // Open the stream IMMEDIATELY with an SSE comment, before any
      // session-dependent traffic.
      //
      // The only thing previously written at start was the per-active-session
      // "connected" status below. With NO active session — a fresh boot, or any
      // client that connects before picking a session — that loop writes
      // nothing, so no bytes ever leave the server and the response headers are
      // never flushed. The connection then looks indistinguishable from a hang:
      // `EventSource.onopen` never fires, and a `fetch`-based consumer blocks on
      // headers until undici's 300s UND_ERR_HEADERS_TIMEOUT (measured
      // 2026-08-02 — 0 bytes in 20s on an idle server).
      //
      // A comment line is ignored by every SSE parser but forces the flush.
      controller.enqueue(encoder.encode(": connected\n\n"));

      for (const sid of sm.getActiveSessionIds()) {
        send(sid, { type: "agent-status", status: "connected" });
      }

      // Keep-alive: an idle stream that sends nothing for minutes can be
      // dropped by an intermediary (or look dead to the client). Comments cost
      // ~13 bytes and are invisible to consumers.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // stream already closed — stop pinging
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
