// @vitest-environment jsdom
/**
 * MediaPlaybackController reconciles desired state against the element,
 * handling the play()/pause() race that bites every naive implementation.
 *
 * The test simulates a slow play() promise: setState({playing:true})
 * starts a play, then setState({playing:false}) lands before the play
 * resolves. Result must be: element ends up paused, NOT playing.
 */
import { describe, it, expect, vi } from "vitest";
import { MediaPlaybackController } from "@/lib/audio/media-playback-controller";

function makeFakeMedia(opts: { playDelayMs?: number } = {}) {
  let paused = true;
  let currentTime = 0;
  let volume = 1;
  let seeking = false;
  const calls: string[] = [];
  const el = {
    get paused() { return paused; },
    get currentTime() { return currentTime; },
    set currentTime(t: number) { currentTime = t; calls.push(`seek:${t}`); },
    get volume() { return volume; },
    set volume(v: number) { volume = v; calls.push(`vol:${v}`); },
    get seeking() { return seeking; },
    play: () => {
      calls.push("play()");
      return new Promise<void>((resolve) => {
        setTimeout(() => { paused = false; resolve(); }, opts.playDelayMs ?? 0);
      });
    },
    pause: () => {
      calls.push("pause()");
      paused = true;
    },
  } as unknown as HTMLMediaElement;
  return {
    el,
    calls,
    getPaused: () => paused,
    setPaused: (p: boolean) => { paused = p; },
    setCurrentTime: (t: number) => { currentTime = t; },
    setSeeking: (s: boolean) => { seeking = s; },
  };
}

describe("MediaPlaybackController", () => {
  it("setState applies seek + volume immediately", () => {
    const { el, calls } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    c.setState({ playing: false, time: 1.5, volume: 0.4 });
    expect(calls).toContain("seek:1.5");
    expect(calls).toContain("vol:0.4");
  });

  it("setState({playing:true}) eventually starts playback", async () => {
    const { el, getPaused } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    c.setState({ playing: true, time: 0, volume: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(getPaused()).toBe(false);
  });

  it("setState({playing:true}) then setState({playing:false}) before play resolves ends paused", async () => {
    const { el, getPaused } = makeFakeMedia({ playDelayMs: 20 });
    const c = new MediaPlaybackController(el);
    c.setState({ playing: true, time: 0, volume: 1 });
    // Race: pause comes in before play resolves.
    c.setState({ playing: false, time: 0, volume: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(getPaused()).toBe(true);
  });

  it("repeated setState calls don't queue duplicate seeks within the threshold", () => {
    const { el, calls } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    c.setState({ playing: false, time: 1.0, volume: 1 });
    c.setState({ playing: false, time: 1.05, volume: 1 });   // tiny drift — no seek
    c.setState({ playing: false, time: 2.0, volume: 1 });    // big drift — seeks
    const seeks = calls.filter((s) => s.startsWith("seek:"));
    expect(seeks).toEqual(["seek:1", "seek:2"]);
  });

  it("during steady playback, small drift does NOT seek (decoder runs free)", () => {
    // The cold-first-play freeze fix: while the element is actually playing,
    // sub-0.45s drift between our wall-clock playhead and the element's media
    // clock must NOT trigger a currentTime write (a seek that re-decodes and
    // interrupts a warming decoder).
    const { el, calls, setPaused, setCurrentTime } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    setPaused(false);           // element is playing natively
    setCurrentTime(3.0);
    c.setState({ playing: true, time: 3.2, volume: 1 }); // 0.2s drift — ignore
    c.setState({ playing: true, time: 3.4, volume: 1 }); // 0.4s drift — ignore
    expect(calls.filter((s) => s.startsWith("seek:"))).toEqual([]);
  });

  it("during steady playback, large drift (>0.45s) DOES seek", () => {
    const { el, calls, setPaused, setCurrentTime } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    setPaused(false);
    setCurrentTime(3.0);
    c.setState({ playing: true, time: 3.6, volume: 1 }); // 0.6s — real hiccup
    expect(calls.filter((s) => s.startsWith("seek:"))).toEqual(["seek:3.6"]);
  });

  it("does not write currentTime while a seek is already in flight (playing)", () => {
    const { el, calls, setPaused, setCurrentTime, setSeeking } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    setPaused(false);
    setCurrentTime(3.0);
    setSeeking(true);            // a prior seek hasn't landed yet
    c.setState({ playing: true, time: 5.0, volume: 1 }); // big drift, but seeking
    expect(calls.filter((s) => s.startsWith("seek:"))).toEqual([]);
  });

  it("paused/scrubbing still snaps tightly at the 0.1s threshold", () => {
    // Regression guard: the tight scrub behavior must be unchanged.
    const { el, calls, setCurrentTime } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    setCurrentTime(1.0);
    c.setState({ playing: false, time: 1.05, volume: 1 }); // tiny — no seek
    c.setState({ playing: false, time: 1.2, volume: 1 });  // >0.1 — seeks
    expect(calls.filter((s) => s.startsWith("seek:"))).toEqual(["seek:1.2"]);
  });

  it("dispose pauses + clears", () => {
    const { el, getPaused } = makeFakeMedia();
    const c = new MediaPlaybackController(el);
    c.setState({ playing: true, time: 0, volume: 1 });
    c.dispose();
    expect(getPaused()).toBe(true);
  });
});
