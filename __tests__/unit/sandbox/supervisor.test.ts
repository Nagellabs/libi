import { describe, it, expect, vi } from "vitest";
import { createBootGate, createSupervisor, type SupervisorWorker } from "@/lib/sandbox/supervisor";
import { PROTOCOL_VERSION, WORKER_BOOTED, type SupervisorReply } from "@/lib/sandbox/protocol";

function fakePort(tag: string) {
  return { tag, postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null } as unknown as MessagePort;
}

function harness(spawnFails: () => boolean = () => false) {
  const workers: Array<SupervisorWorker & { posted: unknown[]; terminate: ReturnType<typeof vi.fn> }> = [];
  const replies: Array<{ msg: SupervisorReply; transfer: Transferable[] }> = [];
  const ports: Array<MessagePort & { tag: string }> = [];
  let n = 0;
  const sup = createSupervisor({
    nonce: "N",
    version: PROTOCOL_VERSION,
    spawn: () => {
      if (spawnFails()) throw new Error("Failed to construct 'Worker'");
      const w = { posted: [] as unknown[], postMessage: vi.fn((m: unknown) => { w.posted.push(m); }), terminate: vi.fn() };
      workers.push(w);
      return w;
    },
    channel: () => {
      n++;
      const port1 = fakePort(`p1-${n}`) as MessagePort & { tag: string };
      const port2 = fakePort(`p2-${n}`) as MessagePort & { tag: string };
      ports.push(port1, port2);
      return { port1, port2 };
    },
    reply: (msg, transfer) => replies.push({ msg, transfer }),
  });
  return { sup, workers, replies, ports };
}

describe("createSupervisor (spec A1)", () => {
  it("start spawns a worker, inits it with port1, and hands port2 to the host in ready", () => {
    const { sup, workers, replies } = harness();
    sup.start();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted[0]).toMatchObject({ t: "init", nonce: "N" });
    expect((workers[0].posted[0] as { port: { tag: string } }).port.tag).toBe("p1-1");
    expect(replies[0].msg).toMatchObject({ t: "ready", nonce: "N", version: PROTOCOL_VERSION });
    expect((replies[0].msg as unknown as { port: { tag: string } }).port.tag).toBe("p2-1");
    expect(replies[0].transfer).toEqual([(replies[0].msg as { port: MessagePort }).port]);
  });
  it("restart terminates the old worker, spawns a fresh one, and sends a NEW ready with a new port", () => {
    const { sup, workers, replies } = harness();
    sup.start();
    sup.handle({ t: "restart", nonce: "N" }, true);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    expect(sup.generation()).toBe(2);
    expect((replies[1].msg as unknown as { port: { tag: string } }).port.tag).toBe("p2-2");
  });
  it("ping answers pong; a wrong nonce, a stranger, or a malformed command is ignored", () => {
    const { sup, workers, replies } = harness();
    sup.start();
    sup.handle({ t: "ping", nonce: "N" }, true);
    expect(replies.at(-1)?.msg).toEqual({ t: "pong", nonce: "N" });
    // The id a ping carries is echoed, so the host pairs each pong with its own ping (R-M5).
    sup.handle({ t: "ping", nonce: "N", id: 7 }, true);
    expect(replies.at(-1)?.msg).toEqual({ t: "pong", nonce: "N", id: 7 });
    sup.handle({ t: "restart", nonce: "forged" }, true);
    sup.handle({ t: "restart", nonce: "N" }, false);
    sup.handle({ t: "explode", nonce: "N" }, true);
    expect(workers).toHaveLength(1);
  });
});

describe("createSupervisor — failures and port hygiene", () => {
  it("reports a worker that will not construct instead of going silent", () => {
    let fail = true;
    const { sup, workers, replies, ports } = harness(() => fail);
    sup.start();
    expect(workers).toHaveLength(0);
    expect(sup.generation()).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0].msg).toMatchObject({ t: "supervisorError", nonce: "N" });
    expect((replies[0].msg as { message: string }).message).toContain("Failed to construct 'Worker'");
    // and the channel it had already made is not leaked
    expect(ports.every((p) => (p.close as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    // a later restart still recovers
    fail = false;
    sup.handle({ t: "restart", nonce: "N" }, true);
    expect(workers).toHaveLength(1);
    expect(replies.at(-1)?.msg).toMatchObject({ t: "ready", nonce: "N" });
  });

  it("closes the previous channel when it restarts", () => {
    const { sup, ports } = harness();
    sup.start();
    const [p1a, p2a] = ports;
    expect((p1a.close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    sup.handle({ t: "restart", nonce: "N" }, true);
    expect((p1a.close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((p2a.close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // the live pair is untouched
    expect((ports[2].close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("a port that throws on close (already transferred) does not break the restart", () => {
    const { sup, workers, ports } = harness();
    sup.start();
    (ports[0].close as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("detached"); });
    sup.handle({ t: "restart", nonce: "N" }, true);
    expect(workers).toHaveLength(2);
  });
});

describe("createBootGate (Task 4 re-review ruling: the relay is a BOOT-failure relay)", () => {
  it("relays before the worker's handshake and stops relaying after it", () => {
    const gate = createBootGate();
    expect(gate.relays()).toBe(true);
    gate.onWorkerMessage({ t: "not-the-marker" });
    gate.onWorkerMessage(null);
    gate.onWorkerMessage("booted");
    expect(gate.relays()).toBe(true);
    gate.onWorkerMessage({ t: WORKER_BOOTED });
    expect(gate.relays()).toBe(false);
  });
});
