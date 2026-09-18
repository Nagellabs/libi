// A separate OS process contending for one piece's storyboard lock, for the
// cross-pid tests in __tests__/unit/storyboard/concurrent-mutations.test.ts.
// Run with tsx (resolves the "@/" alias from the repo tsconfig).
//
// env: LIBI_HOME, PIECE, NAME, OUT (jsonl: one {name,a,b} per hold),
//      STALE_MS, HOLD_MS (hold this long once inside), GO_FILE (if set, hold
//      until this file exists instead — at most GO_TIMEOUT_MS, default 20 s,
//      then exit 1).
// stdout protocol: "waiting" just before asking for the lock, "held" once inside.
import fs from "fs";
import { withStoryboardLock, __setStoryboardLockTuningForTests } from "@/lib/storyboard/lock";

const env = process.env;
__setStoryboardLockTuningForTests({ staleMs: Number(env.STALE_MS ?? 30_000), acquireTimeoutMs: 20_000 });
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.stdout.write("waiting\n");
  await withStoryboardLock(env.PIECE!, async () => {
    const a = now();
    process.stdout.write("held\n");
    if (env.GO_FILE) {
      // Bounded: if the test dies (a waiter crashed, the runner timed out), a
      // holder must not poll forever on CI.
      const giveUpAt = Date.now() + Number(env.GO_TIMEOUT_MS ?? 20_000);
      while (!fs.existsSync(env.GO_FILE)) {
        if (Date.now() > giveUpAt) throw new Error("go file never appeared");
        await sleep(10);
      }
    } else {
      await sleep(Number(env.HOLD_MS ?? 0));
    }
    fs.appendFileSync(env.OUT!, JSON.stringify({ name: env.NAME, a, b: now() }) + "\n");
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  },
);
