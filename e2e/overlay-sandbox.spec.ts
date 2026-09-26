import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext, BrowserContext, Page, Request } from "@playwright/test";
import { test, expect } from "./helpers/app";

/**
 * Spec §7 (Playwright), as amended by A1 and A4: the overlay sandbox is the
 * boundary. A hostile body that tries to reach the studio API, the network,
 * storage, navigation or a window fails every time and leaves an error
 * diagnostic the agent can read (`libi.get_piece_state`, framed as untrusted);
 * nothing it tries reaches the studio or the network; it cannot forge the
 * runtime's messages for a sibling, and an error flood does not reach the
 * supervisor thread. A `while(true){}` body is dropped by the watchdog, its
 * sibling keeps rendering through the restarted worker, and the fixed body
 * renders again.
 *
 * The bodies are obfuscated ON PURPOSE. `add_overlay` runs the regex denylist
 * (lib/ai/scene-validator.ts) on the write path, so a literal `fetch(` never
 * reaches the runtime; the denylist is defence in depth, not the boundary, and
 * a hostile template gets past it exactly like this (`self["fe"+"tch"]`).
 *
 * "Reached nothing" is measured three ways, each with a positive control so a
 * silent recorder cannot pass the test vacuously:
 *  - Playwright's network interception (`context.route`) records every probe
 *    URL that got past the browser's own checks to the network layer — it must
 *    record none. Control: a same-origin blob worker in the APP (not the
 *    sandbox) fetching a marked URL IS routed, and so is the runtime bundle the
 *    sandboxed frame loads — worker- and sandbox-frame requests are visible.
 *  - Every browser request event is kept with its outcome: a probe request the
 *    browser refused (CSP) shows up as a request that FAILED, never one that
 *    got a response.
 *  - A canary HTTP/WebSocket server in the test process stands in for "the
 *    network": the probes aim at it and it must see no connection at all.
 *    Control: the test reaches it itself.
 * The studio side is also checked by effect: the piece a probe tries to DELETE
 * still exists, no piece was created, the app did not navigate or open a page.
 *
 * Watchdog (constraints, Amendment A4): only the request the worker is on is
 * timed; a body's FIRST render (after a load, on a fresh worker, at a new size,
 * after 60 s idle) gets the 5 s budget, every later render 2 s. The wedge test
 * below times a FIRST render — the body wedges the first time it is drawn — so
 * it is dropped after 5 s and says "timed out after 5 s".
 */

// ── the canary: "the network" ──────────────────────────────────────────────

interface Canary {
  port: number;
  /** Every HTTP request and WebSocket upgrade it saw, in order. */
  hits: string[];
  close(): Promise<void>;
}

async function startCanary(): Promise<Canary> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("access-control-allow-origin", "*");
    res.end("canary");
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── the network recorder ───────────────────────────────────────────────────

/** Every probe URL carries this marker; controls carry `libi-control`. */
const PROBE = "libi-probe";
const CONTROL = "libi-control";

interface RecordedRequest {
  url: string;
  method: string;
  outcome: "pending" | "response" | "failed";
  status?: number;
  failure?: string;
}

interface NetworkLog {
  /** URLs Playwright's interception saw reach the network layer. */
  routed: string[];
  requests(): RecordedRequest[];
  /** WebSockets the page opened. */
  sockets: string[];
}

async function recordNetwork(context: BrowserContext, page: Page): Promise<NetworkLog> {
  const routed: string[] = [];
  await context.route(new RegExp(`${PROBE}|${CONTROL}|/api/sandbox/runtime-bundle`), async (route) => {
    routed.push(route.request().url());
    await route.continue();
  });
  const byRequest = new Map<Request, RecordedRequest>();
  context.on("request", (r) => byRequest.set(r, { url: r.url(), method: r.method(), outcome: "pending" }));
  context.on("response", (resp) => {
    const rec = byRequest.get(resp.request());
    if (rec) Object.assign(rec, { outcome: "response", status: resp.status() });
  });
  context.on("requestfailed", (r) => {
    const rec = byRequest.get(r);
    if (rec) Object.assign(rec, { outcome: "failed", failure: r.failure()?.errorText });
  });
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  return { routed, requests: () => Array.from(byRequest.values()), sockets };
}

/**
 * Nothing a probe tried got anywhere: no probe URL reached the network layer,
 * every probe request the browser saw failed, no socket opened, the canary saw
 * nothing. Returns the refused requests for the report.
 */
function expectNothingReached(net: NetworkLog, canary: Canary): RecordedRequest[] {
  const probes = net.requests().filter((r) => r.url.includes(PROBE));
  expect(net.routed.filter((u) => u.includes(PROBE)), "a probe URL reached the network layer").toEqual([]);
  for (const r of probes) expect(r.outcome, `${r.method} ${r.url} got a response`).not.toBe("response");
  expect(net.sockets.filter((u) => u.includes(PROBE)), "a probe opened a WebSocket").toEqual([]);
  expect(canary.hits.filter((h) => h.includes(PROBE)), "the canary (the network) was reached").toEqual([]);
  return probes;
}

// ── studio helpers ─────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Diagnostic {
  overlayId: string;
  kind: string;
  phase: string;
  message: string;
  messageSource: string;
  line?: number;
  column?: number;
  time?: number;
  frame?: number;
  file?: string;
}

interface Unattributed {
  message: string;
  messageSource: string;
  at: number;
}

/** A 1920×1080 piece (pinned: a new piece defaults to 9:16) with one overlay
 *  that is NOT a body — white text at the bottom-left — to prove the preview
 *  keeps compositing whatever the bodies do. */
async function newPiece(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/pieces");
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const dims = await request.patch(`/api/pieces/${id}/composition/dimensions`, { data: { width: 1920, height: 1080 } });
  expect(dims.ok(), await dims.text()).toBe(true);
  const text = await runTool(request, "libi.add_overlay", {
    pieceId: id, kind: "text", displayName: "alive", content: "alive", startTime: 0, duration: 30,
    rect: { x: 100, y: 900, width: 400, height: 100 }, font: "700 64px Inter", color: "#ffffff", align: "left", z: 0, opacity: 1,
  });
  expect(text.success, text.error).toBe(true);
  return id;
}

async function runTool(request: APIRequestContext, tool: string, args: Record<string, unknown>) {
  const res = await request.post("/api/e2e/run-tool", { data: { tool, args } });
  return (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
}

async function addCode(request: APIRequestContext, pieceId: string, displayName: string, body: string, rect: Rect): Promise<{ id: string; file: string }> {
  const json = await runTool(request, "libi.add_overlay", {
    pieceId, kind: "code", displayName, body, rect, startTime: 0, duration: 30, z: 5, opacity: 1,
  });
  expect(json.success, `${displayName}: ${json.error}`).toBe(true);
  return { id: String(json.data?.overlayId ?? ""), file: String(json.data?.codeFilePath ?? "") };
}

async function moveOverlay(request: APIRequestContext, pieceId: string, overlayId: string, rect: Rect): Promise<void> {
  const json = await runTool(request, "libi.update_overlay", { pieceId, overlayId, rect });
  expect(json.success, json.error).toBe(true);
}

async function removeOverlay(request: APIRequestContext, pieceId: string, overlayId: string): Promise<void> {
  const json = await runTool(request, "libi.remove_overlay", { pieceId, overlayId });
  expect(json.success, json.error).toBe(true);
}

/** What the AGENT reads: `libi.get_piece_state`'s render diagnostics. Every
 *  entry must carry the untrusted-source label. */
async function diagnostics(request: APIRequestContext, pieceId: string): Promise<{ attributed: Diagnostic[]; unattributed: Unattributed[] }> {
  const json = await runTool(request, "libi.get_piece_state", { pieceId });
  expect(json.success, json.error).toBe(true);
  const attributed = (json.data?.renderDiagnostics ?? []) as Diagnostic[];
  const unattributed = (json.data?.unattributedRenderDiagnostics ?? []) as Unattributed[];
  for (const d of [...attributed, ...unattributed]) expect(d.messageSource).toBe("overlay body (untrusted)");
  return { attributed, unattributed };
}

type Colour = "white" | "red";

/** Is there a `colour` pixel in a 20×20 box around composition point (x, y)? */
async function paintedAt(page: Page, x: number, y: number, colour: Colour): Promise<boolean> {
  return page.locator('[data-testid="preview-canvas"]').evaluate((el: HTMLCanvasElement, [px, py, c]) => {
    const ctx = el.getContext("2d");
    if (!ctx) return false;
    const cx = Math.round((Number(px) / 1920) * el.width);
    const cy = Math.round((Number(py) / 1080) * el.height);
    const d = ctx.getImageData(Math.max(0, cx - 10), Math.max(0, cy - 10), 20, 20).data;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (c === "white" ? r > 180 && g > 180 && b > 180 : r > 180 && g < 90 && b < 90) return true;
    }
    return false;
  }, [x, y, colour] as const);
}

/** Opens the piece and waits for the non-body text to paint. Asserts the
 *  bodies run in the REAL sandbox — an `<iframe sandbox="allow-scripts">` at
 *  the runtime path — never the dev-only in-origin mode, or every "refused"
 *  below would prove nothing about the boundary. */
async function openPiece(page: Page, pieceId: string): Promise<void> {
  await page.goto(`/editor?piece=${pieceId}`);
  await expect(page.locator('[data-testid="editor-panel"]')).toBeVisible({ timeout: 30_000 });
  // A `?piece=` deep link opens the piece on its Posting tab (the Social
  // page's link); the preview lives on the Timeline tab.
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect.poll(() => paintedAt(page, 150, 950, "white"), { timeout: 30_000 }).toBe(true);
}

/** The sandbox boots with the piece's first body, so call this after adding one. */
async function expectRealSandbox(page: Page): Promise<void> {
  const frame = page.locator('iframe[src^="/sandbox/overlay-runtime"]');
  await expect(frame).toHaveCount(1, { timeout: 20_000 });
  expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
}

/** The sandbox's body worker (opaque origin, so its blob URL is `blob:null/…`). */
function sandboxWorker(page: Page) {
  return page.workers().find((w) => w.url().startsWith("blob:null/"));
}

/** Counts the dedicated workers the page spawns — the sandbox's body worker
 *  among them — so a restart is observable (a new one opens, the old closes). */
function trackWorkers(page: Page): { opened: () => number; closed: () => number } {
  let opened = 0;
  let closed = 0;
  page.on("worker", (w) => {
    if (!w.url().startsWith("blob:null/")) return; // the opaque-origin sandbox worker only
    opened++;
    w.on("close", () => closed++);
  });
  return { opened: () => opened, closed: () => closed };
}

/**
 * Pings the SUPERVISOR directly — the sandboxed iframe's main thread — the
 * way the host does (`{ t: "ping", nonce }`, the nonce from the frame's URL
 * fragment), and times each `pong`. Also counts every OTHER message the frame
 * posts meanwhile: the supervisor must not be relaying anything.
 */
async function pingSupervisor(page: Page, count: number, gapMs: number): Promise<{ rtts: number[]; other: number; startedAt: number; endedAt: number }> {
  return page.evaluate(async ([n, gap]) => {
    const iframe = document.querySelector('iframe[src^="/sandbox/overlay-runtime"]') as HTMLIFrameElement;
    const nonce = new URLSearchParams(new URL(iframe.src).hash.slice(1)).get("n");
    const rtts: number[] = [];
    let other = 0;
    let pending: ((t: number) => void) | null = null;
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      if ((ev.data as { t?: string })?.t === "pong" && pending) {
        pending(performance.now());
        pending = null;
      } else other++;
    };
    window.addEventListener("message", onMessage);
    const startedAt = Date.now();
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const t1 = await new Promise<number>((resolve) => {
        pending = resolve;
        iframe.contentWindow?.postMessage({ t: "ping", nonce }, "*");
        setTimeout(() => {
          if (pending === resolve) {
            pending = null;
            resolve(Number.POSITIVE_INFINITY);
          }
        }, 2000);
      });
      rtts.push(t1 - t0);
      await new Promise((r) => setTimeout(r, gap));
    }
    window.removeEventListener("message", onMessage);
    return { rtts, other, startedAt, endedAt: Date.now() };
  }, [count, gapMs] as const);
}

/** Fills the box: white when it is at least 1.5× wider than tall, red
 *  otherwise. Colour depends on the box's ASPECT (scale-free), so a resize to
 *  a wide box turns it white only through a FRESH render — a held bitmap
 *  stretched onto the new box stays red. */
const ASPECT_FILL = `const { ctx, width, height } = context;
ctx.fillStyle = width >= height * 1.5 ? "#ffffff" : "#ff2020";
ctx.fillRect(0, 0, width, height);`;
const WHITE_FILL = `context.ctx.fillStyle = "#ffffff"; context.ctx.fillRect(0, 0, context.width, context.height);`;

/**
 * A body that walks the worker global's prototype chain from
 * `Object.getPrototypeOf(self)` up — DedicatedWorkerGlobalScope,
 * WorkerGlobalScope, EventTarget, Object — and calls every own copy of `name`
 * it finds with `arg`, each in its own try, then throws ONE error naming the
 * chain it walked and what each copy did ("called" = the real one ran). A copy
 * the hardening missed cannot hide behind one that throws first. `name` is
 * spliced in as two string halves so the denylist does not see it.
 */
function chainWalk(name: string, arg: string): string {
  const [a, b] = [name.slice(0, 3), name.slice(3)];
  return [
    `const walked = [], copies = [];`,
    `for (let o = Object.getPrototypeOf(self); o; o = Object.getPrototypeOf(o)) {`,
    `const c = Object.getOwnPropertyDescriptor(o, "constructor"); const who = c && c.value ? c.value.name : "?"; walked.push(who);`,
    `const d = Object.getOwnPropertyDescriptor(o, "${a}" + "${b}");`,
    `if (d && typeof d.value === "function") { try { d.value.call(self, ${arg}); copies.push(who + ": called"); } catch (e) { copies.push(who + ": " + e.message); } }`,
    `} throw new Error("walked " + walked.join(" > ") + "; " + copies.join(" | "));`,
  ].join(" ");
}

/** One unattributed report per this many ms leaves the worker (the runtime's
 *  `ASYNC_REPORT_INTERVAL_MS`, 1000, in lib/sandbox/runtime/serve.ts); a probe
 *  that fails only asynchronously must not share that window with another. */
const ASYNC_REPORT_GAP_MS = 1200;

test.describe("overlay sandbox — the boundary holds against a hostile body", () => {
  let canary: Canary;

  test.beforeAll(async () => {
    canary = await startCanary();
    // Control: the canary counts what reaches it.
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${canary.port}/${CONTROL}`, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
    });
    expect(canary.hits).toEqual([`GET /${CONTROL}`]);
  });

  test.afterAll(async () => {
    await canary?.close();
  });

  test("synchronous refusals: every hostile body fails with a diagnostic naming what was refused, and nothing is reached", async ({ page, request, context }) => {
    test.setTimeout(150_000);
    const net = await recordNetwork(context, page);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    // The piece a probe tries to delete — not the one on screen.
    const sentinelRes = await request.post("/api/pieces");
    const sentinelId = ((await sentinelRes.json()) as { id: string }).id;
    const piecesBefore = ((await (await request.get("/api/pieces")).json()) as unknown[]).length;

    await openPiece(page, pieceId);
    const appUrl = page.url();
    const studio = `http://127.0.0.1:${new URL(appUrl).port}`;
    const network = `http://127.0.0.1:${canary.port}`;

    // Control for the recorder: a same-origin blob worker in the APP fetches
    // a marked studio URL. Interception must see it and it must get a 200 —
    // so worker-originated requests are visible to what follows.
    const controlUrl = `/api/pieces/${sentinelId}?${CONTROL}=worker`;
    const controlStatus = await page.evaluate(async (url) => {
      const src = `fetch(${JSON.stringify(new URL(url, location.href).href)}).then((r) => postMessage(r.status), (e) => postMessage(String(e)));`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      const status = await new Promise((resolve) => { w.onmessage = (ev) => resolve(ev.data); });
      w.terminate();
      return status;
    }, controlUrl);
    expect(controlStatus).toBe(200);
    expect(net.routed.some((u) => u.includes(`${CONTROL}=worker`)), "interception did not see a worker's request").toBe(true);

    /** name → [body, what the agent must be told]. */
    const probes: Record<string, [string, RegExp]> = {
      // ── the studio API and the network through fetch ──
      "fetch-delete-sentinel": [`self["fe"+"tch"]("/api/pieces/${sentinelId}?${PROBE}=fetch-delete", { method: "DELETE" });`, /fetch is not available inside an overlay body/],
      "fetch-no-cors-post": [`self["fe"+"tch"]("${studio}/api/pieces?${PROBE}=fetch-post", { method: "POST", mode: "no-cors", body: "{}" });`, /fetch is not available inside an overlay body/],
      "fetch-char-codes": [`const n = String.fromCharCode(102, 101, 116, 99, 104); self[n]("${network}/${PROBE}/fetch-char-codes");`, /fetch is not available inside an overlay body/],
      "fetch-function-global": [`const G = self["Func"+"tion"]("return th"+"is")(); G[["fe", "tch"].join("")]("${network}/${PROBE}/fetch-function-global");`, /fetch is not available inside an overlay body/],
      // The real fetch lives on WorkerGlobalScope.prototype too (measured):
      // every copy on the chain must be the stub. The walk starts BELOW the
      // global (whose own copy the probes above already call), names every
      // prototype it passes and calls every copy it finds, so the message pins
      // both the chain and each copy's answer.
      "fetch-prototype-walk": [chainWalk("fetch", `"${network}/${PROBE}/fetch-prototype-walk"`),
        /^walked DedicatedWorkerGlobalScope > WorkerGlobalScope > EventTarget > Object; WorkerGlobalScope: fetch is not available inside an overlay body$/],
      "xhr": [`const x = new self["XMLHttp"+"Request"](); x.open("POST", "${studio}/api/pieces?${PROBE}=xhr"); x.send();`, /XMLHttpRequest is not available inside an overlay body/],
      "eventsource": [`new self["Event"+"Source"]("${studio}/api/agent/events?${PROBE}=eventsource");`, /EventSource is not available inside an overlay body/],
      "send-beacon": [`navigator["send"+"Beacon"]("${network}/${PROBE}/send-beacon", "x");`, /is not a function/],
      // ── scripts and workers ──
      // Not in script-src: throws synchronously (and the CSP reports it).
      "import-scripts-studio": [`self["imp"+"ortScripts"]("${studio}/api/pieces?${PROBE}=import-scripts");`, /importScripts.*failed to load/],
      "import-scripts-network": [`self["imp"+"ortScripts"]("${network}/${PROBE}/import-scripts.js");`, /importScripts.*failed to load/],
      "nested-worker": [`new self["Wor"+"ker"]("data:text/javascript,");`, /Worker is not available inside an overlay body/],
      "shared-worker": [`new self["Shared"+"Worker"]("data:text/javascript,");`, /is not a constructor/],
      // Not exposed in the opaque-origin worker (measured: `typeof` is
      // "undefined"). If a Chromium ever exposes it, this fails and the probe
      // belongs with the CSP-refused ones in the next test.
      "webtransport": [`new self["WebTrans"+"port"]("${network.replace("http:", "https:")}/${PROBE}/webtransport");`, /self\["WebTransport"\] is not a constructor/],
      // ── storage ──
      "cookie": [`const c = document["coo"+"kie"]; context.ctx.fillText(String(c), 0, 0);`, /document is not defined/],
      "local-storage": [`const s = self["local"+"Storage"]; context.ctx.fillText(String(s.length), 0, 0);`, /Cannot read properties of undefined \(reading 'length'\)/],
      "session-storage": [`const s = self["session"+"Storage"]; context.ctx.fillText(String(s.length), 0, 0);`, /Cannot read properties of undefined \(reading 'length'\)/],
      "indexeddb": [`self["indexed"+"DB"].open("x");`, /Cannot read properties of undefined \(reading 'open'\)/],
      // Chromium also defines indexedDB as an accessor on the prototype.
      "indexeddb-prototype-walk": [`let db; for (let o = self; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, "indexed"+"DB"); if (d && !db) db = d.get ? d.get.call(self) : d.value; } db.open("x");`, /Cannot read properties of undefined \(reading 'open'\)/],
      "caches": [`self["cac"+"hes"].open("x");`, /Cannot read properties of undefined \(reading 'open'\)/],
      // ── navigation and windows ──
      "window-open": [`self["op"+"en"]("about:blank");`, /is not a function/],
      "top-navigation": [`top["loca"+"tion"] = "https://example.com/";`, /top is not defined/],
      "location-assign": [`self["loca"+"tion"]["assign"]("https://example.com/");`, /is not a function/],
      // ── the supervisor thread and the parent window ──
      "postmessage-parent": [`parent["post"+"Message"]({ t: "ready" }, "*");`, /parent is not defined/],
      "postmessage-self": [`self["post"+"Message"]({ t: "ready" });`, /postMessage is not available inside an overlay body/],
      // Measured: NO prototype below the global owns a postMessage — WebIDL
      // puts a [Global] interface's operations on the global itself, whose copy
      // "postmessage-self" calls. The walk pins that layout: a Chromium that
      // grew a copy on a prototype fails this loudly, whichever it answered.
      "postmessage-prototype-walk": [chainWalk("postMessage", `{ t: "ready" }`),
        /^walked DedicatedWorkerGlobalScope > WorkerGlobalScope > EventTarget > Object; $/],
      // Ending the worker would leave every later render unanswered and the
      // watchdog blaming a sibling.
      "close-worker": [`self["clo"+"se"]();`, /close is not available inside an overlay body/],
      // ── task sources the owner tagging cannot see (Task 13 fix round 3) ──
      // A callback any of these runs announces no owner, so a wedge in it fell
      // to the two-offence fallback. Each fails where the body calls it.
      "message-channel": [`const c = new self["Message"+"Channel"](); c.port1.onmessage = () => { for (;;); }; c.port2["post"+"Message"](1);`, /^MessageChannel is not available inside an overlay body$/],
      "broadcast-channel": [`new self["Broadcast"+"Channel"]("x");`, /^BroadcastChannel is not available inside an overlay body$/],
      "scheduler-post-task": [`self["sched"+"uler"].postTask(() => { for (;;); }, { delay: 1000 });`, /^Cannot read properties of undefined \(reading 'postTask'\)$/],
      // Measured: `scheduler` is a WorkerGlobalScope.prototype accessor only.
      // Every copy on the chain — the global's own, which the hardening
      // defines, and the prototype's — must read undefined.
      "scheduler-prototype-walk": [`const seen = []; for (let o = self; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, "sched"+"uler"); if (d) seen.push(typeof (d.get ? d.get.call(self) : d.value)); } throw new Error("scheduler copies: " + seen.join(","));`,
        /^scheduler copies: undefined,undefined$/],
      "abort-signal-timeout": [`self["Abort"+"Signal"].timeout(1000).onabort = () => { for (;;); };`, /^AbortSignal\.timeout is not available inside an overlay body$/],
      // Every own `timeout` from TaskSignal (which extends AbortSignal) up.
      "abort-signal-timeout-chain": [`const seen = []; for (let o = self["Task"+"Signal"]; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, "time"+"out"); if (d) { try { d.value.call(o, 1); seen.push(o.name + ": called"); } catch (e) { seen.push(o.name + ": " + e.message); } } } throw new Error(seen.join(" | "));`,
        /^AbortSignal: AbortSignal\.timeout is not available inside an overlay body$/],
      // CONTROL: AbortSignal itself stays usable (three's loaders use it).
      "abort-signal-usable": [`const c = new self["Abort"+"Controller"](); c.abort(); throw new Error("aborted=" + c.signal.aborted + " any=" + typeof self["Abort"+"Signal"].any);`, /^aborted=true any=function$/],
      "performance-observer": [`new self["Performance"+"Observer"](() => { for (;;); }).observe({ entryTypes: ["mark"] });`, /^PerformanceObserver is not available inside an overlay body$/],
      "reporting-observer": [`new self["Reporting"+"Observer"](() => { for (;;); }).observe();`, /^ReportingObserver is not available inside an overlay body$/],
      // Measured: every one of these is an own property of the global only; no
      // prototype below it owns a copy. A Chromium that grew one fails loudly.
      "task-sources-prototype-walk": [`const names = ["Message"+"Channel", "Broadcast"+"Channel", "Performance"+"Observer", "Reporting"+"Observer"]; const found = []; for (let o = Object.getPrototypeOf(self); o; o = Object.getPrototypeOf(o)) for (const n of names) if (Object.getOwnPropertyDescriptor(o, n)) found.push(n); throw new Error("copies below the global: [" + found.join(",") + "]");`,
        /^copies below the global: \[\]$/],
      // CONTROL, not a probe: the one studio URL the runtime CSP lets a body
      // load (script-src names the bundle's path; CSP path matching ignores
      // the query). Interception must see it — proof that it sees requests
      // from the opaque-origin worker inside the sandboxed frame itself, not
      // only from an app worker or the frame's document.
      // The request goes out and is answered (200), yet importScripts reports
      // it failed to load (measured) — either way the body gets nothing.
      "control-sandbox-worker-request": [`self["imp"+"ortScripts"]("${studio}/api/sandbox/runtime-bundle?${CONTROL}=sandbox-worker");`,
        /^Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'http:\/\/127\.0\.0\.1:\d+\/api\/sandbox\/runtime-bundle\?libi-control=sandbox-worker' failed to load\.$/],
    };

    const ids: Record<string, string> = {};
    let slot = 0;
    for (const [name, [body]] of Object.entries(probes)) {
      const x = 600 + (slot % 4) * 220;
      const y = Math.floor(slot / 4) * 90;
      ids[name] = (await addCode(request, pieceId, name, body, { x, y, width: 200, height: 80 })).id;
      slot++;
    }
    await expectRealSandbox(page);
    // Control: the sandboxed frame's own requests are visible to interception.
    expect(net.routed.some((u) => u.includes("/api/sandbox/runtime-bundle")), "interception did not see the sandbox frame's request").toBe(true);
    // …and so are the sandbox WORKER's (the control body above), with their
    // outcome: this one reached the studio and was answered.
    await expect
      .poll(() => net.routed.some((u) => u.includes(`${CONTROL}=sandbox-worker`)), { timeout: 20_000, message: "interception did not see the sandbox worker's request" })
      .toBe(true);
    await expect
      .poll(() => net.requests().some((r) => r.url.includes(`${CONTROL}=sandbox-worker`) && r.outcome === "response" && r.status === 200), { timeout: 20_000 })
      .toBe(true);

    await expect
      .poll(async () => {
        const { attributed } = await diagnostics(request, pieceId);
        const have = new Set(attributed.map((d) => d.overlayId));
        return Object.keys(ids).filter((name) => !have.has(ids[name]));
      }, { timeout: 30_000, message: "every hostile body should leave a diagnostic" })
      .toEqual([]);

    const { attributed } = await diagnostics(request, pieceId);
    test.info().annotations.push({
      type: "diagnostics",
      description: JSON.stringify(Object.fromEntries(Object.keys(probes).map((name) => [name, attributed.find((x) => x.overlayId === ids[name])?.message]))),
    });
    for (const [name, [, expected]] of Object.entries(probes)) {
      const d = attributed.find((x) => x.overlayId === ids[name]);
      expect(d?.message, name).toMatch(expected);
      expect(d?.phase, name).toBe("render");
      expect(d?.kind, name).toBe("code");
      expect(d?.frame, name).toBe(0);
      expect(d?.time, name).toBe(0);
      expect(d?.line, name).toBe(1);
      expect(d?.file, name).toMatch(/draw\.jsx$/);
    }
    // No body was timed out: every refusal is synchronous, so the worker was
    // never restarted.
    expect(attributed.filter((d) => /timed out/.test(d.message))).toEqual([]);
    expect(workers.opened()).toBe(1);
    expect(workers.closed()).toBe(0);

    // Nothing happened. The pieces exist, none was created, the app did not
    // navigate or open a page, and the non-body overlay still paints.
    expect((await request.get(`/api/pieces/${pieceId}`)).status()).toBe(200);
    expect((await request.get(`/api/pieces/${sentinelId}`)).status()).toBe(200);
    expect(((await (await request.get("/api/pieces")).json()) as unknown[]).length).toBe(piecesBefore);
    await page.waitForTimeout(1000);
    expect(page.url()).toBe(appUrl);
    expect(context.pages()).toHaveLength(1);
    expect(await paintedAt(page, 150, 950, "white")).toBe(true);
    // Every probe here is refused before a request exists (a stub throws, or
    // the CSP check precedes the fetch), so the browser may record none.
    const refused = expectNothingReached(net, canary);
    test.info().annotations.push({ type: "refused-requests", description: JSON.stringify(refused) });
  });

  test("asynchronous refusals: the CSP refuses a WebSocket, a WebSocketStream, a remote font and a dynamic import, and the runtime reports each", async ({ page, request, context }) => {
    test.setTimeout(120_000);
    const net = await recordNetwork(context, page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);
    const studio = `127.0.0.1:${new URL(page.url()).port}`;
    const network = `127.0.0.1:${canary.port}`;

    // These fail only after the body returned — the constructor does not
    // throw (A1) — so they surface as `unattributed`, one report per
    // ASYNC_REPORT_INTERVAL_MS from the whole worker. One probe at a time,
    // removed before the next, so no report can mask another.
    const probes: Array<[string, string, RegExp]> = [
      ["websocket-studio", `new self["Web"+"Socket"]("ws://${studio}/${PROBE}/websocket-studio");`,
        new RegExp(`blocked by the sandbox policy: connect-src \\(ws://${studio}/${PROBE}/websocket-studio\\)`)],
      ["websocket-network", `new self["Web"+"Socket"]("ws://${network}/${PROBE}/websocket-network");`,
        new RegExp(`blocked by the sandbox policy: connect-src \\(ws://${network}/${PROBE}/websocket-network\\)`)],
      ["dynamic-import-network", `self["Func"+"tion"]("u", "return imp"+"ort(u)")("http://${network}/${PROBE}/dynamic-import.js");`,
        new RegExp(`(blocked by the sandbox policy: script-src\\S* \\(|Failed to fetch dynamically imported module: )http://${network}/${PROBE}/dynamic-import\\.js`)],
      // Exposed in the worker (measured), and its constructor does not throw.
      // "Web"+"Socket" split: the denylist matches the word.
      ["websocket-stream-network", `new self["Web"+"Socket"+"Stream"]("ws://${network}/${PROBE}/websocket-stream");`,
        new RegExp(`blocked by the sandbox policy: connect-src \\(ws://${network}/${PROBE}/websocket-stream\\)`)],
      // A1 gives the worker fonts on purpose (FontFace from an ArrayBuffer);
      // a url() source meets font-src data: and is refused. The load's own
      // rejection ("A network error occurred.", no URL) is caught: left
      // unhandled it races the CSP report for the one unattributed slot and,
      // winning, masks it (seen in 1 run of 3).
      ["font-face-url-network", `new self["Font"+"Face"]("probe", "url(http://${network}/${PROBE}/font.woff2)").load().catch(() => {});`,
        new RegExp(`blocked by the sandbox policy: font-src \\(http://${network}/${PROBE}/font\\.woff2\\)`)],
    ];
    const seen: string[] = [];
    const reported: Record<string, string> = {};
    for (const [name, body, expected] of probes) {
      const { id } = await addCode(request, pieceId, name, body, { x: 600, y: 100, width: 200, height: 80 });
      await expectRealSandbox(page);
      try {
        await expect
          .poll(async () => (await diagnostics(request, pieceId)).unattributed.map((d) => d.message).find((m) => expected.test(m)) ?? "", { timeout: 20_000 })
          .toMatch(expected);
      } catch (err) {
        // What the agent was told instead, read when the poll gave up.
        throw new Error(`${name} was never reported. Diagnostics at the end: ${JSON.stringify(await diagnostics(request, pieceId))}\n${err instanceof Error ? err.message : String(err)}`);
      }
      const now = await diagnostics(request, pieceId);
      reported[name] = now.unattributed.map((d) => d.message).find((m) => expected.test(m)) ?? "";
      // It threw nothing synchronously: no diagnostic names the overlay.
      expect(now.attributed.filter((d) => d.overlayId === id)).toEqual([]);
      seen.push(name);
      await removeOverlay(request, pieceId, id);
      await page.waitForTimeout(ASYNC_REPORT_GAP_MS);
    }
    expect(seen).toEqual(probes.map(([name]) => name));
    test.info().annotations.push({ type: "diagnostics", description: JSON.stringify(reported) });
    expect(await paintedAt(page, 150, 950, "white")).toBe(true);
    const refused = expectNothingReached(net, canary);
    test.info().annotations.push({ type: "refused-requests", description: JSON.stringify(refused) });
  });

  test("a body that patches MessagePort cannot forge the runtime's messages for a sibling", async ({ page, request }) => {
    test.setTimeout(90_000);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);

    const victim = await addCode(request, pieceId, "victim", ASPECT_FILL, { x: 1500, y: 100, width: 200, height: 200 });
    await expectRealSandbox(page);
    await expect.poll(() => paintedAt(page, 1600, 200, "red"), { timeout: 20_000 }).toBe(true);

    // Everything the channel could route through, patched; each patch forges
    // an `error` for the victim, with the nonce of the message it intercepted
    // — the forgery would be accepted if the runtime's channel ever called it.
    // `hits` counts calls that touched a MessagePort or a MessageEvent.
    const forger = await addCode(request, pieceId, "forger", `
const S = self;
if (!S.__forge) {
  S.__forge = { hits: 0, sites: [] };
  const hit = (site) => { S.__forge.hits++; if (S.__forge.sites.indexOf(site) < 0) S.__forge.sites.push(site); };
  const RA = Reflect.apply;
  const forge = (port, msg) => {
    try {
      if (msg && typeof msg === "object" && msg.nonce) RA(orig, port, [{ t: "error", nonce: msg.nonce, id: "${victim.id}", phase: "render", message: "FORGED by the forger", req: msg.req }, []]);
    } catch (e) {}
  };
  const P = MessagePort.prototype;
  const orig = P["post"+"Message"];
  P["post"+"Message"] = function (msg, transfer) { hit("MessagePort.prototype.postMessage"); forge(this, msg); return RA(orig, this, [msg, transfer]); };
  const dataGet = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
  Object.defineProperty(MessageEvent.prototype, "data", { configurable: true, get() { if (this.target instanceof MessagePort) hit("MessageEvent.prototype.data"); return RA(dataGet, this, []); } });
  Reflect.apply = function (f, t, a) { if (t instanceof MessagePort || t instanceof MessageEvent) { hit("Reflect.apply"); forge(t, a && a[0]); } return RA(f, t, a); };
  Function.prototype.call = function (t, ...a) { if (t instanceof MessagePort || t instanceof MessageEvent) { hit("Function.prototype.call"); forge(t, a[0]); } return RA(this, t, a); };
  Function.prototype.apply = function (t, a) { if (t instanceof MessagePort || t instanceof MessageEvent) { hit("Function.prototype.apply"); forge(t, a && a[0]); } return RA(this, t, a || []); };
}
throw new Error("forger hits=" + S.__forge.hits + " sites=" + S.__forge.sites.join("|"));`, { x: 100, y: 500, width: 200, height: 100 });

    // The patch is in once the forger's first render ran. Read from the
    // sandbox worker's own realm (harness access, not a body's): a forgery
    // that loops (each forged error makes the host re-request, which posts
    // again) can starve the diagnostics debounce, so the worker's own count
    // is the signal that cannot be masked.
    const forgeState = async () =>
      (await sandboxWorker(page)?.evaluate(() => (self as unknown as { __forge?: { hits: number; sites: string[] } }).__forge ?? null)) ?? null;
    await expect.poll(async () => (await forgeState()) !== null, { timeout: 20_000 }).toBe(true);

    // Traffic through the patched realm: the victim re-renders at a new size
    // — white only through a FRESH render, so a layer was posted after the
    // patch — and the forger reports again.
    await moveOverlay(request, pieceId, victim.id, { x: 1300, y: 100, width: 500, height: 200 });
    try {
      await expect.poll(() => paintedAt(page, 1550, 200, "white"), { timeout: 20_000 }).toBe(true);
    } catch (err) {
      // The forger's count when the poll GAVE UP — read here, not when the
      // poll began, which is all a template string in its options could show.
      throw new Error(
        `the victim never repainted — forged answers to its renders? forger state at the end: ${JSON.stringify(await forgeState())}\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
    expect(await forgeState()).toEqual({ hits: 0, sites: [] });
    await moveOverlay(request, pieceId, forger.id, { x: 100, y: 500, width: 260, height: 120 });
    await expect
      .poll(async () => (await diagnostics(request, pieceId)).attributed.find((d) => d.overlayId === forger.id)?.message ?? "", { timeout: 20_000 })
      .toBe("forger hits=0 sites=");

    // Nothing was forged: the victim has no diagnostic and still paints, and
    // "FORGED" appears nowhere the agent reads.
    await page.waitForTimeout(1000);
    const after = await diagnostics(request, pieceId);
    expect(after.attributed.filter((d) => d.overlayId === victim.id)).toEqual([]);
    expect([...after.attributed, ...after.unattributed].filter((d) => d.message.includes("FORGED"))).toEqual([]);
    expect(await forgeState()).toEqual({ hits: 0, sites: [] });
    expect(await paintedAt(page, 1550, 200, "white")).toBe(true);
  });

  test("an error flood from a body never reaches the supervisor: it answers ping within 100 ms throughout", async ({ page, request }) => {
    test.setTimeout(90_000);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);

    const victim = await addCode(request, pieceId, "victim", ASPECT_FILL, { x: 1500, y: 100, width: 200, height: 200 });
    await expectRealSandbox(page);
    await expect.poll(() => paintedAt(page, 1600, 200, "red"), { timeout: 20_000 }).toBe(true);
    const baseline = await pingSupervisor(page, 10, 50);
    expect(Math.max(...baseline.rtts)).toBeLessThan(100);

    // 900 uncaught throws per burst, a burst per task, for 8 s: microtasks,
    // unhandled rejections and timers. Uncancelled, each would re-fire at the
    // Worker object on the supervisor thread (Task 7 re-review N1).
    await addCode(request, pieceId, "flood", `
const S = self;
if (!S.__flood) {
  S.__flood = { bursts: 0 };
  const end = performance.now() + 8000;
  const burst = () => {
    S.__flood.bursts++;
    for (let i = 0; i < 300; i++) {
      queueMicrotask(() => { throw new Error("flood microtask " + i); });
      Promise.reject(new Error("flood rejection " + i));
      setTimeout(() => { throw new Error("flood timer " + i); }, 0);
    }
    if (performance.now() < end) setTimeout(burst, 0);
  };
  burst();
}
${WHITE_FILL}`, { x: 100, y: 100, width: 200, height: 200 });
    // The flood is running once its first report lands.
    await expect
      .poll(async () => (await diagnostics(request, pieceId)).unattributed.some((d) => /^flood /.test(d.message)), { timeout: 20_000 })
      .toBe(true);

    const during = await pingSupervisor(page, 20, 100);
    test.info().annotations.push({ type: "ping-rtts-ms", description: JSON.stringify({ baseline: baseline.rtts, during: during.rtts }) });
    expect(during.rtts).toHaveLength(20);
    for (const rtt of during.rtts) expect(rtt).toBeLessThan(100);
    // The supervisor relayed nothing but pongs.
    expect(during.other).toBe(0);

    // The flood was live across the ping window: reports kept arriving in it.
    const { unattributed } = await diagnostics(request, pieceId);
    const floodReports = unattributed.filter((d) => /^flood /.test(d.message));
    expect(floodReports.some((d) => d.at >= during.startedAt && d.at <= during.endedAt), "the flood ended before the pings").toBe(true);
    // …rate-limited: one report per ASYNC_REPORT_INTERVAL_MS left the
    // worker, not thousands (host-observed times, so allow delivery jitter).
    const ats = floodReports.map((d) => d.at).sort((a, b) => a - b);
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(500);

    // The worker was never wedged or replaced, and it still renders fresh.
    await moveOverlay(request, pieceId, victim.id, { x: 1300, y: 100, width: 500, height: 200 });
    await expect.poll(() => paintedAt(page, 1550, 200, "white"), { timeout: 20_000 }).toBe(true);
    expect(workers.opened()).toBe(1);
    expect(workers.closed()).toBe(0);
    expect((await diagnostics(request, pieceId)).attributed.filter((d) => /timed out/.test(d.message))).toEqual([]);
  });

  test("while(true){} on its FIRST render is dropped by the 5 s budget, the sibling renders through the restarted worker, and the fixed body renders", async ({ page, request }) => {
    test.setTimeout(120_000);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);

    const good = await addCode(request, pieceId, "good", ASPECT_FILL, { x: 1500, y: 100, width: 200, height: 200 });
    await expectRealSandbox(page);
    await expect.poll(() => paintedAt(page, 1600, 200, "red"), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => workers.opened(), { timeout: 10_000 }).toBe(1);

    // The body wedges on its FIRST render, so the 5 s first-render budget is
    // the one that runs out (A4) — not the 2 s budget of a later render.
    const t0 = Date.now();
    const hang = await addCode(request, pieceId, "hang", "while (true) {}", { x: 1500, y: 400, width: 200, height: 200 });
    await expect
      .poll(async () => (await diagnostics(request, pieceId)).attributed.find((d) => d.overlayId === hang.id)?.message ?? "", { timeout: 20_000 })
      .toMatch(/^timed out after 5 s$/);
    const elapsed = Date.now() - t0;
    test.info().annotations.push({ type: "wedge-dropped-after-ms", description: String(elapsed) });
    // Never before the budget; the rest is the composition refetch, the 300 ms
    // diagnostics debounce and this poll.
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(11_000);
    const afterDrop = await diagnostics(request, pieceId);
    expect(afterDrop.attributed.find((d) => d.overlayId === hang.id)?.phase).toBe("render");
    // Only the wedged body is blamed.
    expect(afterDrop.attributed.filter((d) => d.overlayId !== hang.id)).toEqual([]);

    // The worker was replaced (A1 §4): a fresh one opened, the old one closed.
    await expect.poll(() => workers.opened(), { timeout: 10_000 }).toBe(2);
    await expect.poll(() => workers.closed(), { timeout: 10_000 }).toBe(1);

    // The sibling renders THROUGH the new worker: a wide box turns it white,
    // which only a fresh render produces.
    await moveOverlay(request, pieceId, good.id, { x: 1100, y: 650, width: 400, height: 200 });
    await expect.poll(() => paintedAt(page, 1300, 750, "white"), { timeout: 20_000 }).toBe(true);
    expect(await paintedAt(page, 150, 950, "white")).toBe(true);
    // The dropped body stays dropped while its source is unchanged: nothing
    // re-arms the watchdog (no second restart).
    await page.waitForTimeout(6000);
    expect(workers.opened()).toBe(2);

    // Fix the file on disk — the agent's path: it edits `codeFilePath` and the
    // storage watcher reloads it. A new source hash lifts the drop.
    expect(hang.file).toMatch(/draw\.jsx$/);
    fs.writeFileSync(hang.file, `${WHITE_FILL}\n`);
    await expect.poll(() => paintedAt(page, 1600, 500, "white"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await diagnostics(request, pieceId)).attributed.some((d) => d.overlayId === hang.id), { timeout: 10_000 }).toBe(false);
    expect(workers.opened()).toBe(2);
  });

  test("a slow body (400 ms a frame) is measured within its own budget on its FIRST render: never timed out by the content-fit probe, fitted over its whole timeline", async ({ page, request }) => {
    // Review I1 of the 2026-09-25 fit fix: a probe of 17 frames at 400 ms is
    // 6.8 s, past the 5 s first-render budget — the body would be dropped. The
    // probe always paints the five coarse frames (first, last, middle,
    // quarters) and anything more only within its own 1.5 s budget, so this
    // body renders — six calls, as before the fix — fitted to BOTH squares.
    test.setTimeout(120_000);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);
    const slow = await addCode(
      request,
      pieceId,
      "slow",
      `const t0 = Date.now(); while (Date.now() - t0 < 400) {}
const { ctx, width, height, time } = context;
ctx.fillStyle = "#ffffff";
ctx.fillRect(width * 0.25, height * 0.25, width * 0.25, height * 0.25);
if (time >= 20) ctx.fillRect(width * 0.5, height * 0.5, width * 0.25, height * 0.25);`,
      { x: 1300, y: 100, width: 400, height: 400 },
    );
    await expectRealSandbox(page);
    // The union box is the middle half of the rect → scale 2: at t = 0 the
    // first square fills the rect's top-left quadrant, and nothing is drawn in
    // the bottom-right one (the late square is not on screen yet). A probe
    // that saw only the first second would fit the first square alone (scale
    // 4) and paint the whole rect; a dropped body paints nothing.
    await expect.poll(() => paintedAt(page, 1400, 200, "white"), { timeout: 30_000 }).toBe(true);
    expect(await paintedAt(page, 1650, 450, "white")).toBe(false);
    const { attributed } = await diagnostics(request, pieceId);
    expect(attributed.filter((d) => d.overlayId === slow.id)).toEqual([]);
    expect(workers.opened()).toBe(1);
    expect(workers.closed()).toBe(0);
  });

  test("a body that leaves a never-ending setTimeout(…, 0) behind is the one dropped — never the sibling the watchdog is timing", async ({ page, request }) => {
    test.setTimeout(120_000);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);

    const good = await addCode(request, pieceId, "good", ASPECT_FILL, { x: 1500, y: 100, width: 200, height: 200 });
    await expectRealSandbox(page);
    await expect.poll(() => paintedAt(page, 1600, 200, "red"), { timeout: 20_000 }).toBe(true);

    // It draws and RETURNS; the timer it leaves behind never does. Before the
    // render bracket its answer went out first, the worker wedged between
    // renders, and the watchdog dropped the sibling asked for next.
    const t0 = Date.now();
    const later = await addCode(request, pieceId, "wedge-later", `setTimeout(() => { for (;;); }, 0);\n${WHITE_FILL}`, { x: 1500, y: 400, width: 200, height: 200 });
    // The sibling asks for a fresh render while the worker is wedged.
    await page.waitForTimeout(1500);
    await moveOverlay(request, pieceId, good.id, { x: 1100, y: 650, width: 400, height: 200 });

    // The hostile body is blamed at once: its timer runs before the runtime's
    // answer, so its own render — its first, with the load budget — is the one
    // timed out. No unattributed fallback, one restart.
    await expect
      .poll(async () => (await diagnostics(request, pieceId)).attributed.find((d) => d.overlayId === later.id)?.message ?? "", { timeout: 40_000 })
      .toMatch(/^timed out after 5 s$/);
    const { attributed, unattributed } = await diagnostics(request, pieceId);
    test.info().annotations.push({
      type: "wedge-later",
      description: JSON.stringify({ afterMs: Date.now() - t0, message: attributed.find((d) => d.overlayId === later.id)?.message, unattributed: unattributed.map((u) => u.message), workersOpened: workers.opened() }),
    });
    // The sibling is never blamed; no unannounced-wedge fallback ran.
    expect(attributed.filter((d) => d.overlayId !== later.id)).toEqual([]);
    expect(unattributed.filter((u) => /stopped answering between renders/.test(u.message))).toEqual([]);
    // One offence, one restart.
    await expect.poll(() => workers.opened(), { timeout: 10_000 }).toBe(2);

    // The sibling renders through the fresh worker at its new, wide size.
    await expect.poll(() => paintedAt(page, 1300, 750, "white"), { timeout: 20_000 }).toBe(true);
    expect(await paintedAt(page, 150, 950, "white")).toBe(true);
    // And the dropped body stays dropped: no further restart.
    const opened = workers.opened();
    await page.waitForTimeout(6000);
    expect(workers.opened()).toBe(opened);
    expect((await diagnostics(request, pieceId)).attributed.filter((d) => d.overlayId !== later.id)).toEqual([]);
  });
  test("a body whose DELAYED timer wedges long after its answer is dropped at its first offence — the sibling asking next is untouched", async ({ page, request }) => {
    test.setTimeout(120_000);
    const workers = trackWorkers(page);
    const pieceId = await newPiece(request);
    await openPiece(page, pieceId);

    const good = await addCode(request, pieceId, "good", ASPECT_FILL, { x: 1500, y: 100, width: 200, height: 200 });
    await expectRealSandbox(page);
    await expect.poll(() => paintedAt(page, 1600, 200, "red"), { timeout: 20_000 }).toBe(true);

    // It draws and RETURNS, and its answer goes out; a second later, with no
    // render of anyone's in flight, the timer it left behind takes the thread
    // and never gives it back. Before owner tagging (Task 13 fix round 2) that
    // wedge announced nothing: the next render asked for was the sibling's,
    // which never started, and only a second offence got the body dropped.
    // Its callback now says whose it is before it runs.
    const t0 = Date.now();
    const later = await addCode(request, pieceId, "wedge-delayed", `setTimeout(() => { for (;;); }, 1000);\n${WHITE_FILL}`, { x: 1500, y: 400, width: 200, height: 200 });
    await expect.poll(() => paintedAt(page, 1600, 500, "white"), { timeout: 20_000 }).toBe(true);
    // Well after the timer fired: the sibling asks for a fresh render, which
    // the wedged worker never starts.
    await page.waitForTimeout(3000);
    await moveOverlay(request, pieceId, good.id, { x: 1100, y: 650, width: 400, height: 200 });

    // The body is blamed by the watchdog on its first offence, with the 2 s a
    // callback gets from when it took the thread.
    await expect
      .poll(async () => (await diagnostics(request, pieceId)).attributed.find((d) => d.overlayId === later.id)?.message ?? "", { timeout: 30_000 })
      .toMatch(/^timed out after 2 s$/);
    const { attributed, unattributed } = await diagnostics(request, pieceId);
    test.info().annotations.push({
      type: "wedge-delayed",
      description: JSON.stringify({ afterMs: Date.now() - t0, unattributed: unattributed.map((u) => u.message), workersOpened: workers.opened() }),
    });
    // The sibling is never blamed; no unannounced-wedge fallback ran.
    expect(attributed.filter((d) => d.overlayId !== later.id)).toEqual([]);
    expect(unattributed.filter((u) => /stopped answering between renders/.test(u.message))).toEqual([]);
    // One offence, one restart.
    await expect.poll(() => workers.opened(), { timeout: 10_000 }).toBe(2);

    // The sibling renders through the fresh worker at its new, wide size.
    await expect.poll(() => paintedAt(page, 1300, 750, "white"), { timeout: 20_000 }).toBe(true);
    // The dropped body stays dropped: no further restart.
    await page.waitForTimeout(6000);
    expect(workers.opened()).toBe(2);
    expect((await diagnostics(request, pieceId)).attributed.filter((d) => d.overlayId !== later.id)).toEqual([]);
  });
});

/**
 * The effect sampler (lib/sandbox/effect-sampler.ts) is the boundary for
 * custom effect `animate.js` bodies: its own opaque-origin frame and worker run
 * the body and answer with a table of numbers the page interpolates
 * (lib/effects/custom-curves.ts). Its unit tests stub the transport; this one
 * proves a real browser boots the sampler, gets a curve back and moves pixels.
 *
 * The body is benign, and it proves its own realm: it shifts the text 400 px
 * only where there is no `document` AND the origin is opaque (`"null"`) — the
 * sampler's worker. Run on the page it answers 0 (a `document` exists); in the
 * dev-only in-origin worker (`LIBI_OVERLAY_SANDBOX=0`) it answers 0 too (the
 * origin is `http://…`). So moved pixels alone say where the body ran; the
 * frame and worker checks below corroborate it.
 */
const REALM_PROVING_SHIFT = `return { dx: typeof document === "undefined" && self.origin === "null" ? 400 : 0 };`;

test.describe("effect sampler — a custom effect body runs in its own sandbox", () => {
  test("a custom effect body runs in the sampler sandbox and its curve moves real pixels", async ({ page, request }) => {
    // Room for `openPiece` (up to 60 s), the sampler's cold boot inside the
    // pixel poll (the product allows it 60 s, SAMPLER_BOOT_TIMEOUT_MS), and the
    // cleanup in `finally` after a full poll.
    test.setTimeout(150_000);
    const pieceId = await newPiece(request); // white "alive" text at (100,900)-(500,1000)
    await openPiece(page, pieceId);          // waits for white at (150,950)
    const workers = trackWorkers(page);

    const add = await runTool(request, "libi.add_effect", {
      id: "e2e-shift", name: "E2E shift", family: "animation", phases: ["loop"], supports: ["text"],
      source: REALM_PROVING_SHIFT,
    });
    expect(add.success, add.error).toBe(true);
    try {
      const overlays = await runTool(request, "libi.get_overlays", { pieceId });
      const textId = String((overlays.data?.overlays as Array<{ id: string; kind: string }>).find((o) => o.kind === "text")?.id);
      const apply = await runTool(request, "libi.apply_layer_effect", { pieceId, layerId: textId, phase: "loop", effectId: "e2e-shift" });
      expect(apply.success, apply.error).toBe(true);

      // The page draws identity until the sampler answers, then repaints
      // shifted — through the tool's OWN `composition` refresh (the route adds
      // none). The first sample boots the sampler frame cold, hence 60 s.
      await expect.poll(() => paintedAt(page, 550, 950, "white"), { timeout: 60_000 }).toBe(true);
      expect(await paintedAt(page, 150, 950, "white")).toBe(false);
      // it ran in an opaque-origin worker (blob:null/…), the sampler's — no overlay body exists in this piece
      expect(workers.opened()).toBeGreaterThanOrEqual(1);
      // …spawned by the REAL sampler frame — an `<iframe sandbox="allow-scripts">`
      // in the sampler's own mount, never the dev-only in-origin transport — and
      // the overlay sandbox never booted, so that worker is the sampler's.
      const samplerFrame = page.locator('#libi-effect-sandbox-mount iframe[src^="/sandbox/overlay-runtime"]');
      await expect(samplerFrame).toHaveCount(1);
      expect(await samplerFrame.getAttribute("sandbox")).toBe("allow-scripts");
      await expect(page.locator('iframe[src^="/sandbox/overlay-runtime"]')).toHaveCount(1);
    } finally {
      // The effect lives in the e2e home's effect registry, not in the piece:
      // remove it so later specs (and a re-run against the same home) start clean.
      // Soft: a failed cleanup is reported without masking the real failure.
      expect.soft((await runTool(request, "libi.remove_effect", { id: "e2e-shift" })).success).toBe(true);
    }
  });
});
