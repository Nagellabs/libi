"use client";

import { OVERLAY_RUNTIME_BUNDLE_PATH } from "./paths";
import type { SandboxTransport } from "./host";
import type { SupervisorReply } from "./protocol";
import { PROTOCOL_VERSION, type SupervisorCommand } from "./protocol-supervisor";
import { createSupervisor, describeError, relayBootFailures, type Supervisor } from "./supervisor";

/**
 * Dev-only (lib/sandbox/mode.ts): the SAME worker script the supervisor spawns
 * (spec A1), but as a same-origin blob: worker in THIS window — no iframe, no
 * opaque origin, no supervisor page. This module plays the supervisor by
 * running the supervisor's own logic (`createSupervisor`, `relayBootFailures`)
 * in-page, so `init` / `ready` / `restart` / `ping` and the worker's `booted`
 * handshake behave exactly as they do behind the boundary. The worker hardens
 * its own globals either way; what differs is only the missing frame boundary,
 * which is the point when the runtime itself is what needs diagnosing. Never
 * selected in a packaged build or a production server.
 */
export interface InOriginDeps {
  fetchWorkerSource?(): Promise<string>;
  spawn?(source: string): Worker;
  channel?(): { port1: MessagePort; port2: MessagePort };
}

async function fetchWorkerSourceDefault(): Promise<string> {
  // Allowed by the APP policy (`connect-src 'self'`); the sandbox page could
  // never do this, which is why the supervisor bundle embeds the worker.
  const res = await fetch(`${OVERLAY_RUNTIME_BUNDLE_PATH}?part=worker`);
  if (!res.ok) throw new Error(`overlay worker bundle: ${res.status}`);
  return res.text();
}

export function createInOriginTransport(nonce: string, deps: InOriginDeps = {}): SandboxTransport {
  // The host trusts a reply only when its `source` is this exact object — the
  // in-page counterpart of the iframe's contentWindow.
  const peer = Object.freeze({ inOrigin: true });
  const fetchSource = deps.fetchWorkerSource ?? fetchWorkerSourceDefault;
  const channel = deps.channel ?? (() => new MessageChannel());
  let workerUrl: string | null = null;
  const spawn =
    deps.spawn ??
    ((source: string): Worker => {
      // Classic worker, like the sandbox (A1) — `worker-src 'self' blob:` admits
      // it. One blob URL per transport (the source never changes), revoked on
      // destroy.
      workerUrl ??= URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      return new Worker(workerUrl, { name: "libi-overlay-runtime (in-origin)" });
    });

  let handler: ((data: unknown, source: unknown) => void) | null = null;
  let destroyed = false;
  let fetching = false;
  let supervisor: Supervisor | null = null;
  let current: Worker | null = null;

  const reply = (msg: SupervisorReply): void => {
    if (!destroyed) handler?.(msg, peer);
  };
  const fail = (message: string): void => reply({ t: "supervisorError", nonce, message: message.slice(0, 2000) });

  /** Fetch the worker bundle once, then hand over to the supervisor logic. A
   *  failed fetch is a boot failure like any other: reported, and retried on
   *  the host's next (backed-off) `restart`. */
  const boot = (): void => {
    if (fetching || destroyed) return;
    fetching = true;
    fetchSource().then(
      (code) => {
        fetching = false;
        if (destroyed) return;
        supervisor = createSupervisor({
          nonce,
          version: PROTOCOL_VERSION,
          channel,
          spawn: () => {
            const worker = spawn(code);
            relayBootFailures(worker, fail);
            current = worker;
            return worker;
          },
          reply: (msg) => reply(msg),
        });
        supervisor.start();
      },
      (err: unknown) => {
        fetching = false;
        fail(describeError(err));
      },
    );
  };
  boot();

  return {
    peer,
    command(msg: SupervisorCommand) {
      if (destroyed) return;
      // Every command is "from the parent": there is no other sender here.
      if (supervisor) {
        supervisor.handle(msg, true);
        return;
      }
      if (msg.nonce !== nonce) return;
      if (msg.t === "ping") reply({ t: "pong", nonce, ...(msg.id !== undefined ? { id: msg.id } : {}) });
      else boot();
    },
    onReply(h) {
      handler = h;
    },
    destroy() {
      destroyed = true;
      handler = null;
      supervisor = null;
      current?.terminate();
      current = null;
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    },
  };
}
