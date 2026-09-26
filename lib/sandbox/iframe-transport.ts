"use client";

import { OVERLAY_RUNTIME_PATH } from "./paths";
import type { SandboxTransport } from "./host";
import type { SupervisorCommand } from "./protocol";

/**
 * The real iframe leg: an `<iframe sandbox="allow-scripts">` at the runtime
 * path (spec §4.1) hosting the supervisor. No `allow-same-origin` — that is
 * what makes the origin opaque although the URL is same-origin, so the app's
 * `frame-src 'self'` admits it unchanged. The nonce travels in the fragment
 * (never sent to the server, never in a referrer — `referrerpolicy="no-referrer"`).
 * Only `restart` / `ping` go down this leg; the worker port carries the rest.
 */
export function createIframeTransport(mount: HTMLElement, nonce: string): SandboxTransport {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("loading", "eager");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText =
    "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
  iframe.src = `${OVERLAY_RUNTIME_PATH}#n=${encodeURIComponent(nonce)}`;
  mount.appendChild(iframe);

  // The frame's document has LOADED: its one script — the supervisor — has
  // run, so it has said `ready` or never will (re-review R-M4). Until then
  // the host does not read silence as death: a cold compile of the runtime
  // page and its bundle can take many seconds. Attached after insertion, so
  // only the runtime document's own load is heard.
  let loaded = false;
  let loadHandler: (() => void) | null = null;
  const onFrameLoad = (): void => {
    loaded = true;
    loadHandler?.();
  };
  iframe.addEventListener("load", onFrameLoad);

  let listener: ((ev: MessageEvent) => void) | null = null;
  return {
    get peer() {
      return iframe.contentWindow;
    },
    command(msg: SupervisorCommand) {
      // The frame's origin is opaque and cannot be named — "*" is the only
      // valid target; the supervisor in turn accepts only `window.parent`.
      iframe.contentWindow?.postMessage(msg, "*");
    },
    onReply(handler) {
      if (listener) window.removeEventListener("message", listener);
      listener = (ev: MessageEvent) => handler(ev.data, ev.source);
      window.addEventListener("message", listener);
    },
    onLoad(handler) {
      loadHandler = handler;
      if (loaded) handler();
    },
    destroy() {
      if (listener) window.removeEventListener("message", listener);
      listener = null;
      iframe.removeEventListener("load", onFrameLoad);
      loadHandler = null;
      iframe.remove();
    },
  };
}
