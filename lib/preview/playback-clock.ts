export class PlaybackClock {
  private anchorComp = 0;
  private anchorCtx = 0;
  private speed = 1;
  private paused = true;

  /** @param now returns the master context time in seconds (ctx.currentTime). */
  constructor(private readonly now: () => number) {}

  getCompositionTime(): number {
    if (this.paused) return this.anchorComp;
    return this.anchorComp + (this.now() - this.anchorCtx) * this.speed;
  }
  play(): void { if (!this.paused) return; this.anchorCtx = this.now(); this.paused = false; }
  pause(): void { if (this.paused) return; this.anchorComp = this.getCompositionTime(); this.paused = true; }
  seek(t: number): void { this.anchorComp = t; this.anchorCtx = this.now(); }
  setSpeed(s: number): void { this.anchorComp = this.getCompositionTime(); this.anchorCtx = this.now(); this.speed = s; }
  get isPaused(): boolean { return this.paused; }
}
