// lib/storyboard/render/worker-entry.ts
//
// Standalone, isolated worker for storyboard sketch rasterization.
//
// SECURITY (RC-C): this is the ONLY place an agent-authored, `new Function`-
// compiled draw/render body is executed. It is spawned as a CHILD PROCESS by
// `renderUnitToPng` (see ./index.ts) under Node's permission model with NO
// `--allow-fs-write` and NO `--allow-child-process` — so even if a malicious
// body bypasses the `validateDrawFunction` denylist, it cannot write files or
// spawn processes (the RCE primitives are permission-denied).
//
// Network capability is stripped IN-PROCESS below (fetch / WebSocket /
// XMLHttpRequest / Request / Response / Headers set to `undefined`) BEFORE any
// untrusted body runs. This is necessary because Node's permission model does
// NOT gate network, and the app's CSP (`connect-src 'self'`) does NOT apply to a
// Node process — CSP only constrains the browser renderer, never this worker. So
// without this strip a denylist-bypassing body could `fetch()` in-scope file
// bytes out. This is defense-in-depth on top of the permission model.
//
// Residual risk — a body reading a file it shouldn't within the granted
// `--allow-fs-read` scope — is bounded by that read scoping plus the deferred
// deep-isolation plan; it is NOT the RCE / exfil vector those two mitigations
// close.
//
// Protocol:
//   stdin  — a single JSON job `{ kind, source, frame, extra }`
//   stdout — raw PNG bytes on success (fd 1, binary)
//   stderr — a single JSON line `{ error }` on failure, plus a non-zero exit
//
// Only serializable data crosses the process boundary; `ctx`/`rough`/`INK`/
// `GRAYS`/`h` are constructed INSIDE the render functions, so nothing but the
// job JSON needs to be passed in.

import { validateDrawFunction } from "../../ai/scene-validator";
import { renderCanvasUnit } from "./canvas";
import { renderSvgUnit } from "./svg";
import { renderSatoriUnit } from "./satori";
import type { RenderFrame } from "./hyperscript";
import type { RenderUnitKind } from "../types";

// SECURITY (RC-C): neutralize network-capable globals before ANY untrusted body
// is validated/compiled/executed. Node's permission model does not gate network,
// so this in-process strip is the thing that stops a denylist-bypassing body from
// exfiltrating in-scope file bytes. Legitimate rendering (satori/svg/canvas) uses
// only in-memory data + locally-vendored fonts and needs no network, so stripping
// these does not affect valid renders. Best-effort per global (some may be
// non-configurable on a given runtime).
for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "Request", "Response", "Headers"]) {
  try {
    (globalThis as Record<string, unknown>)[name] = undefined;
  } catch {
    /* non-configurable global — leave as-is; the permission model still blocks RCE */
  }
}

type Job = {
  kind: RenderUnitKind;
  source: string;
  frame: RenderFrame;
  extra?: Record<string, unknown>;
};

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const job = JSON.parse(raw.toString("utf8")) as Job;

  // Same validation the in-process path used to do — kept HERE so the untrusted
  // body is never even syntax-compiled in the parent server process.
  const v = validateDrawFunction(job.source);
  if (!v.valid) throw new Error(`invalid render unit: ${v.error}`);

  const extra = job.extra ?? {};
  let png: Buffer;
  switch (job.kind) {
    case "canvas":
      png = await renderCanvasUnit(job.source, job.frame, extra);
      break;
    case "svg":
      png = renderSvgUnit(job.source, job.frame, extra);
      break;
    case "satori":
      png = await renderSatoriUnit(job.source, job.frame, extra);
      break;
    default:
      throw new Error(`unknown render unit kind: ${String(job.kind)}`);
  }

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(png, (err) => (err ? reject(err) : resolve()));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  });
