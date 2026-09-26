// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createInOriginTransport } from "@/lib/sandbox/in-origin-transport";
import { PROTOCOL_VERSION, WORKER_BOOTED } from "@/lib/sandbox/protocol";

function fakePort(tag: string) {
  return { tag, postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null } as unknown as MessagePort;
}

type Listener = (ev: unknown) => void;
interface FakeWorker {
  source: string;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  addEventListener(type: string, fn: Listener): void;
  /** Deliver a worker-global event, as the real Worker object would. */
  emit(type: string, ev: unknown): void;
}

function harness(opts: { fetchWorkerSource?: () => Promise<string> } = {}) {
  const workers: FakeWorker[] = [];
  let n = 0;
  const t = createInOriginTransport("n9", {
    fetchWorkerSource: opts.fetchWorkerSource ?? (async () => "// the worker bundle"),
    spawn: (source) => {
      const listeners = new Map<string, Listener[]>();
      const w: FakeWorker = {
        source,
        postMessage: vi.fn(),
        terminate: vi.fn(),
        addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        emit: (type, ev) => listeners.get(type)?.forEach((fn) => fn(ev)),
      };
      workers.push(w);
      return w as unknown as Worker;
    },
    channel: () => { n++; return { port1: fakePort(`p1-${n}`), port2: fakePort(`p2-${n}`) }; },
  });
  const replies: Array<{ data: unknown; source: unknown }> = [];
  t.onReply((data, source) => replies.push({ data, source }));
  return { t, workers, replies };
}

describe("createInOriginTransport (LIBI_OVERLAY_SANDBOX=0 — the same worker, no iframe)", () => {
  it("spawns the fetched worker source as a blob worker, inits it with port1, and replies ready with port2 from its own peer", async () => {
    const { t, workers, replies } = harness();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(workers[0].source).toBe("// the worker bundle");
    expect(workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ t: "init", nonce: "n9" }), [expect.objectContaining({ tag: "p1-1" })]);
    expect(replies[0].source).toBe(t.peer);
    expect(replies[0].data).toMatchObject({ t: "ready", nonce: "n9", version: PROTOCOL_VERSION });
    expect((replies[0].data as { port: { tag: string } }).port.tag).toBe("p2-1");
    t.destroy();
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("restart terminates and respawns with a fresh port; ping answers pong", async () => {
    const { t, workers, replies } = harness();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    t.command({ t: "restart", nonce: "n9" });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers).toHaveLength(2);
    expect((replies[1].data as { port: { tag: string } }).port.tag).toBe("p2-2");
    t.command({ t: "ping", nonce: "n9", id: 4 });
    expect(replies.at(-1)?.data).toEqual({ t: "pong", nonce: "n9", id: 4 });
    t.destroy();
    expect(workers[1].terminate).toHaveBeenCalled();
  });

  it("fetches the worker bundle once and reuses it across restarts", async () => {
    const fetchWorkerSource = vi.fn(async () => "// once");
    const { t, workers, replies } = harness({ fetchWorkerSource });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    t.command({ t: "restart", nonce: "n9" });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(fetchWorkerSource).toHaveBeenCalledTimes(1);
    expect(workers.map((w) => w.source)).toEqual(["// once", "// once"]);
    t.destroy();
  });

  it("ignores a command carrying another nonce", async () => {
    const { t, workers, replies } = harness();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    t.command({ t: "ping", nonce: "other" });
    t.command({ t: "restart", nonce: "other" });
    await Promise.resolve();
    expect(replies).toHaveLength(1);
    expect(workers).toHaveLength(1);
    t.destroy();
  });

  it("consumes the worker's booted handshake like the supervisor: boot errors are relayed before it, never after", async () => {
    const { t, workers, replies } = harness();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const w = workers[0];
    w.emit("error", { message: "SyntaxError: bad bundle", preventDefault: vi.fn() });
    expect(replies.at(-1)?.data).toEqual({ t: "supervisorError", nonce: "n9", message: "worker error: SyntaxError: bad bundle" });
    expect(replies.at(-1)?.source).toBe(t.peer);

    w.emit("message", { data: { t: WORKER_BOOTED } });
    const count = replies.length;
    const late = { message: "body threw", preventDefault: vi.fn() };
    w.emit("error", late);
    w.emit("messageerror", {});
    expect(replies).toHaveLength(count); // the worker owns its diagnostics now
    expect(late.preventDefault).toHaveBeenCalled();
    // …and `booted` itself is never forwarded to the host as a reply.
    expect(replies.some((r) => (r.data as { t?: string }).t === WORKER_BOOTED)).toBe(false);
    t.destroy();
  });

  it("reports a failed bundle fetch as a supervisorError, and a restart fetches again", async () => {
    const fetchWorkerSource = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("overlay worker bundle: 500"))
      .mockResolvedValueOnce("// second try");
    const { t, workers, replies } = harness({ fetchWorkerSource });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0].data).toEqual({ t: "supervisorError", nonce: "n9", message: "overlay worker bundle: 500" });
    expect(workers).toHaveLength(0);
    t.command({ t: "ping", nonce: "n9", id: 2 });
    expect(replies.at(-1)?.data).toEqual({ t: "pong", nonce: "n9", id: 2 });
    t.command({ t: "restart", nonce: "n9" });
    await vi.waitFor(() => expect(replies.at(-1)?.data).toMatchObject({ t: "ready" }));
    expect(fetchWorkerSource).toHaveBeenCalledTimes(2);
    expect(workers[0].source).toBe("// second try");
    t.destroy();
  });

  it("after destroy it spawns nothing and replies nothing", async () => {
    let release!: (s: string) => void;
    const { t, workers, replies } = harness({ fetchWorkerSource: () => new Promise<string>((r) => (release = r)) });
    t.destroy();
    release("// late");
    await new Promise((r) => setTimeout(r, 0));
    t.command({ t: "ping", nonce: "n9" });
    t.command({ t: "restart", nonce: "n9" });
    await new Promise((r) => setTimeout(r, 0));
    expect(workers).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
