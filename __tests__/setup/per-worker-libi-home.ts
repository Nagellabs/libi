/**
 * Vitest setup file: run this worker under its OWN LIBI_HOME, `<run root>/w<VITEST_POOL_ID>`.
 *
 * The global setup (`isolate-libi-home.ts`) makes one temp home per run, and every worker inherited it, so two test
 * files running at once shared `<LIBI_HOME>/agent/` (the `skills/writer`, `libi-home`, `mcp-config-mcp-json` and
 * `mcp/workspace*` files all write there) and the install locks under the home. A pool id names one worker slot,
 * and two files never share a slot at the same time. That is narrower than full isolation: vitest frees a slot
 * before the previous worker has fully stopped, so a straggler (a timer, a detached child) of one file can still be
 * running when the next file starts in the same `w<id>`, and `w<id>` is not wiped between files, so leftovers carry
 * over from one file to the next on a slot. A file that needs a clean home still makes its own.
 *
 * This runs before each test file, ahead of its imports, so anything that reads LIBI_HOME at module load sees the
 * worker's home. A file that sets its own LIBI_HOME in `beforeEach` still wins.
 *
 * `CODEX_HOME` gets the same per-worker treatment, for the same reason: the global setup
 * (`isolate-libi-home.ts`) points it at one directory for the whole run, so two test files
 * running at once on different workers would share it — a config write or backup one file makes
 * is visible to the other. `<home>/codex-home` keeps it inside the worker's own folder, isolated
 * the same way `agent/` is.
 */
import fs from "node:fs";
import path from "node:path";
import { linkProvisionedBinaries } from "../helpers/provisioned-bin";
import { RUN_ROOT_ENV } from "./isolate-libi-home";

const runRoot = process.env[RUN_ROOT_ENV];
if (!runRoot) throw new Error(`${RUN_ROOT_ENV} is unset: per-worker-libi-home.ts needs isolate-libi-home.ts as the global setup`);

const home = path.join(runRoot, `w${process.env.VITEST_POOL_ID ?? "0"}`);
fs.mkdirSync(path.join(home, "agent"), { recursive: true });
// The same shape as the run root: the provisioned ffmpeg/ffprobe, not whatever PATH holds.
linkProvisionedBinaries(home);
process.env.LIBI_HOME = home;

const codexHome = path.join(home, "codex-home");
fs.mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
