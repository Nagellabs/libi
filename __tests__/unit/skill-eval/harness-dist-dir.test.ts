/**
 * `npm run skill:eval` spawns `node bin/libi.js` (-> `next dev`) in the repo
 * root with the default `.next`. Next 16 locks `<distDir>/dev/lock` for a dev
 * server, so an eval died with "Another next dev server is already running"
 * whenever the owner's own `npm run dev` / `dev:electron` was up in the same
 * worktree — and then burned the full 180s `waitForPort` timeout before
 * reporting a boot timeout that named none of this.
 *
 * `SKILL_EVAL_NEXT_DIST_DIR` gives the eval's server its own Next dir
 * (`E2E-1` fixed the same class for Playwright with `LIBI_NEXT_DIST_DIR`).
 * `devServerLockMessage` lets the harness recognise Next's refusal in the
 * spawned server's own stdout/stderr and fail fast, naming the PID/Dir Next
 * printed, instead of waiting out the port-file poll.
 */
import { describe, it, expect } from "vitest";
import { SKILL_EVAL_NEXT_DIST_DIR, devServerLockMessage } from "@/scripts/skill-eval/harness";

describe("skill-eval harness Next dist dir", () => {
  it("the eval server builds into its own Next dir", () => {
    expect(SKILL_EVAL_NEXT_DIST_DIR).toBe(".next-skill-eval");
  });
});

describe("devServerLockMessage", () => {
  it("recognises Next's lock refusal and keeps its PID/Dir", () => {
    const log =
      " ⨯ Another next dev server is already running.\n\n" +
      "- Local:        http://localhost:3000\n" +
      "- PID:          4242\n" +
      "- Dir:          /x/wt\n";
    expect(devServerLockMessage(log)).toMatch(/Another next dev server is already running[\s\S]*PID:\s+4242/);
  });

  it("is null when the server booted normally", () => {
    expect(devServerLockMessage("ready in 2.1s")).toBeNull();
  });
});
