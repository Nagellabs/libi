import { it, expect, vi } from "vitest";

/**
 * `electron/shell-updater.ts` — the shell's own update-check cadence.
 *
 * The renderer fetches `/api/runtime/update` as the window loads, so it always
 * beats the first shell-side check. What matters is that the check has settled
 * by the time the client's first poll comes round (`IDLE_POLL_MS`, 30s) — at 15s
 * it had, but the client was not polling at all then, and a 0.1.9 found at
 * boot+15s went unmentioned for 41 minutes (2026-09-07). Both halves of that fix
 * have to hold, so both are pinned: here, and in
 * `__tests__/unit/queries/runtime-update-freshness.test.ts`.
 *
 * These constants are asserted directly rather than through `initShellUpdater`'s
 * full boot sequence — see `shell-updater.test.ts` for that.
 *
 * Importing `shell-updater.ts` pulls in `electron` and `electron-updater` at
 * module scope, so both are mocked here purely so the import doesn't throw —
 * neither is ever called.
 *
 * The two assertions below are deliberately budgets (`toBeLessThanOrEqual`),
 * not literals pinning today's `5_000` / one hour — this file is a guard on
 * the REQUIREMENT ("early enough", "at least hourly"), not on the exact
 * numbers, and it does not exercise `initShellUpdater`'s actual boot
 * sequence (`shell-updater.test.ts` covers that). Tightening it to
 * `toBe(5_000)` would make it fail the moment someone picks a safely smaller
 * delay, for no safety gained.
 */
vi.mock("electron", () => ({ app: {} }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import { FIRST_CHECK_DELAY_MS, RECHECK_INTERVAL_MS } from "@/electron/shell-updater";

it("asks the feed soon enough that the first client fetch can see the answer", () => {
  expect(FIRST_CHECK_DELAY_MS).toBeLessThanOrEqual(5_000);
});

it("re-checks at least hourly", () => {
  expect(RECHECK_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
});
