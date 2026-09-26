// The effect sampler (lib/sandbox/effect-sampler.ts): a sandbox of its own that
// runs custom effect bodies and answers with numbers. One request at a time,
// every answer re-validated, and a body that wedges the worker is timed out,
// blamed and the worker restarted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURVE_FIELDS } from "@/lib/effects/curve";
import { EffectSampler, sampleFailure } from "@/lib/sandbox/effect-sampler";
import type { SandboxTransport } from "@/lib/sandbox/host";

const NONCE = "nonce-1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SAMPLES = 3;

function fakePort() {
  return { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null as null | ((ev: { data: unknown }) => void) };
}

function harness() {
  const peer = {};
  let reply: ((data: unknown, source: unknown) => void) | null = null;
  const commands: unknown[] = [];
  const transports: SandboxTransport[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const sampler = new EffectSampler({
    nonce: () => NONCE,
    samples: SAMPLES,
    createTransport: () => {
      const t: SandboxTransport = {
        peer,
        command: (m) => void commands.push(m),
        onReply: (h) => {
          reply = h;
        },
        destroy: vi.fn(),
      };
      transports.push(t);
      return t;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const ready = () => {
    const port = fakePort();
    reply!({ t: "ready", nonce: NONCE, version: 1, port }, peer);
    return port;
  };
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.fn();
    }
  };
  const rawReply = (data: unknown, source: unknown) => reply!(data, source);
  return { sampler, ready, commands, transports, fire, timers, rawReply, peer };
}

function curveBuffer(samples = SAMPLES, fill = 0.5): ArrayBuffer {
  return new Float64Array(CURVE_FIELDS.length * samples).fill(fill).buffer;
}
const req = (effectId: string, sourceHash = HASH_A) => ({ effectId, source: "return { dx: progress };", sourceHash, params: { amount: 3 } });

afterEach(() => vi.restoreAllMocks());

describe("EffectSampler", () => {
  it("boots its own frame lazily, posts ONE sample at a time, and answers with the sanitized table", async () => {
    const h = harness();
    expect(h.transports).toHaveLength(0);
    const a = h.sampler.sample(req("wobble"));
    const b = h.sampler.sample(req("drift"));
    expect(h.transports).toHaveLength(1);
    const port = h.ready();
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    const sent = port.postMessage.mock.calls[0]![0];
    expect(sent).toMatchObject({ t: "sample", source: "return { dx: progress };", sourceHash: HASH_A, params: { amount: 3 }, samples: SAMPLES });
    port.onmessage!({ data: { t: "curve", nonce: NONCE, id: sent.id, samples: SAMPLES, data: curveBuffer() } });
    const curve = await a;
    expect(curve).toBeInstanceOf(Float64Array);
    expect(curve.length).toBe(CURVE_FIELDS.length * SAMPLES);
    expect(port.postMessage).toHaveBeenCalledTimes(2); // the next one only now
    const second = port.postMessage.mock.calls[1]![0];
    port.onmessage!({ data: { t: "error", nonce: NONCE, id: second.id, phase: "compile", message: "Unexpected token" } });
    await expect(b).rejects.toThrow(sampleFailure("drift", "Unexpected token"));
  });

  it("ignores answers with the wrong nonce or for a request not in flight, and refuses a malformed table", async () => {
    const h = harness();
    const a = h.sampler.sample(req("wobble"));
    const port = h.ready();
    const id = port.postMessage.mock.calls[0]![0].id;
    port.onmessage!({ data: { t: "curve", nonce: "someone-else", id, samples: SAMPLES, data: curveBuffer() } });
    port.onmessage!({ data: { t: "curve", nonce: NONCE, id: "fx-999", samples: SAMPLES, data: curveBuffer() } });
    port.onmessage!({ data: { t: "curve", nonce: NONCE, id, samples: SAMPLES, data: curveBuffer(SAMPLES + 1) } });
    await expect(a).rejects.toThrow(/malformed curve/);
  });

  it("a body that never finishes is timed out, named, and only this sandbox's worker is restarted; the queue goes on", async () => {
    const h = harness();
    const a = h.sampler.sample(req("loop"));
    const b = h.sampler.sample(req("fine"));
    const port = h.ready();
    h.fire(5000);
    await expect(a).rejects.toThrow(/custom effect "loop" could not be sampled in the sandbox: animate did not finish sampling within 5 s/);
    expect(h.commands).toEqual([{ t: "restart", nonce: NONCE }]);
    expect(port.close).toHaveBeenCalled();
    const fresh = h.ready();
    const id = fresh.postMessage.mock.calls[0]![0].id;
    fresh.onmessage!({ data: { t: "curve", nonce: NONCE, id, samples: SAMPLES, data: curveBuffer() } });
    await expect(b).resolves.toBeInstanceOf(Float64Array);
  });

  it("work an EARLIER body left running is blamed on that body, which is refused from then on; the blocked request is asked again", async () => {
    const h = harness();
    const first = h.sampler.sample(req("sneaky", HASH_A));
    const port = h.ready();
    const firstId = port.postMessage.mock.calls[0]![0].id;
    port.onmessage!({ data: { t: "curve", nonce: NONCE, id: firstId, samples: SAMPLES, data: curveBuffer() } });
    await first;
    const victim = h.sampler.sample(req("victim", HASH_B));
    port.onmessage!({ data: { t: "async", nonce: NONCE, id: firstId, sourceHash: HASH_A } });
    h.fire(5000);
    const fresh = h.ready();
    const retried = fresh.postMessage.mock.calls[0]![0];
    expect(retried.sourceHash).toBe(HASH_B);
    fresh.onmessage!({ data: { t: "curve", nonce: NONCE, id: retried.id, samples: SAMPLES, data: curveBuffer() } });
    await expect(victim).resolves.toBeInstanceOf(Float64Array);
    await expect(h.sampler.sample(req("sneaky", HASH_A))).rejects.toThrow(/leaves running after it returns/);
    // A changed source is tried again.
    void h.sampler.sample(req("sneaky", "c".repeat(64))).catch(() => {});
    expect(fresh.postMessage).toHaveBeenCalledTimes(2);
  });

  it("a flood on the port is a wedge: the holder is refused and the worker restarted", async () => {
    const h = harness();
    const a = h.sampler.sample(req("flood"));
    const port = h.ready();
    const id = port.postMessage.mock.calls[0]![0].id;
    for (let i = 0; i < 10_001; i++) port.onmessage!({ data: { t: "asyncDone", nonce: NONCE, id } });
    await expect(a).rejects.toThrow(/flooded the effect sandbox/);
    expect(h.commands).toContainEqual({ t: "restart", nonce: NONCE });
  });

  it("a frame that never says ready fails the waiting samples; destroy fails the rest", async () => {
    const h = harness();
    const a = h.sampler.sample(req("x"));
    h.fire(60_000);
    await expect(a).rejects.toThrow(/did not start/);
    const b = h.sampler.sample(req("y"));
    expect(h.transports).toHaveLength(2);
    h.sampler.destroy();
    await expect(b).rejects.toThrow(/closed/);
    await expect(h.sampler.sample(req("z"))).rejects.toThrow(/closed/);
  });

  it("replies from anything but its own frame, or with the wrong nonce, are ignored", () => {
    const h = harness();
    void h.sampler.sample(req("x")).catch(() => {});
    const stranger = fakePort();
    h.rawReply({ t: "ready", nonce: NONCE, version: 1, port: stranger }, {});
    h.rawReply({ t: "ready", nonce: "wrong", version: 1, port: stranger }, h.peer);
    expect(stranger.postMessage).not.toHaveBeenCalled();
    const own = fakePort();
    h.rawReply({ t: "ready", nonce: NONCE, version: 1, port: own }, h.peer);
    expect(own.postMessage).toHaveBeenCalledTimes(1);
  });
});
