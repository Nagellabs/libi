/**
 * Start a media element and swallow its refusal (autoplay blocked, source
 * gone, a pause racing the play). `play()` returns a promise in every browser
 * libi runs in, but not in every DOM implementation (jsdom's can return
 * undefined, or throw "not implemented") — chaining `.catch` straight off it
 * then throws a TypeError instead of being quiet. Always resolves.
 */
export function playQuietly(el: HTMLMediaElement | null | undefined): Promise<void> {
  if (!el) return Promise.resolve();
  try {
    const p = el.play() as Promise<void> | undefined;
    return p && typeof p.then === "function" ? p.catch(() => {}) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}
