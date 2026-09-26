/**
 * Entry of the supervisor page's ONE script (esbuild bundle root; see
 * lib/sandbox/runtime-bundle.ts, which prepends `__LIBI_WORKER_SOURCE__`).
 * Runs on the iframe's main thread at an opaque origin. Never runs a body.
 */
import { PROTOCOL_VERSION } from "@/lib/sandbox/protocol-supervisor";
import type { SupervisorReply } from "@/lib/sandbox/protocol";
import { createSupervisor, relayBootFailures } from "@/lib/sandbox/supervisor";

declare const __LIBI_WORKER_SOURCE__: string;

const nonce = new URLSearchParams(location.hash.slice(1)).get("n") ?? "";
// A CLASSIC worker: `{ type: "module" }` does not load from an opaque origin
// (spec A1, measured). Its base URL is the blob: URL, so nothing inside it may
// use a relative specifier — the bundle inlines every dependency.
const workerUrl = URL.createObjectURL(new Blob([__LIBI_WORKER_SOURCE__], { type: "text/javascript" }));

const reply = (msg: SupervisorReply, transfer: Transferable[]): void => {
  window.parent.postMessage(msg, "*", transfer);
};

const fail = (message: string): void => {
  reply({ t: "supervisorError", nonce, message: message.slice(0, 2000) }, []);
};

const spawn = () => {
  const worker = new Worker(workerUrl);
  // Boot failures are relayed until the worker's handshake; after it the worker
  // owns its own diagnostics and posts `error { id, phase, line, … }` on the
  // port. See `createBootGate` / `relayBootFailures`.
  relayBootFailures(worker, fail);
  return worker;
};

const supervisor = createSupervisor({
  nonce,
  version: PROTOCOL_VERSION,
  spawn,
  channel: () => new MessageChannel(),
  reply,
});

window.addEventListener("message", (ev) => supervisor.handle(ev.data, ev.source === window.parent));
supervisor.start();
