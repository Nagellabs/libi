/**
 * Every vitest worker runs under its own LIBI_HOME (`__tests__/setup/per-worker-libi-home.ts`), a `w<pool id>`
 * folder under the run's root (`__tests__/setup/isolate-libi-home.ts`). One home for the whole run let two test
 * files running at once share `<LIBI_HOME>/agent/` and the install locks.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getLibiAgentDir, getLibiHome } from "@/lib/libi-home";
import { RUN_ROOT_ENV } from "../../setup/isolate-libi-home";

describe("the per-worker LIBI_HOME", () => {
  it("is this worker's own `w<pool id>` folder, directly under the run root, and exists", () => {
    const home = process.env.LIBI_HOME!;
    const runRoot = process.env[RUN_ROOT_ENV];
    expect(runRoot, `${RUN_ROOT_ENV} is set by the global setup`).toBeTruthy();
    expect(path.basename(home)).toBe(`w${process.env.VITEST_POOL_ID ?? "0"}`);
    expect(path.dirname(home)).toBe(runRoot);
    expect(fs.statSync(home).isDirectory()).toBe(true);
  });

  it("is what libi resolves, so the agent dir sits inside it and not in the shared run root", () => {
    const home = process.env.LIBI_HOME!;
    expect(getLibiHome()).toBe(home);
    expect(getLibiAgentDir().startsWith(home + path.sep)).toBe(true);
    expect(getLibiAgentDir()).not.toBe(path.join(process.env[RUN_ROOT_ENV]!, "agent"));
  });

  it("carries the provisioned media binaries the run root carries, so ffmpeg tests keep libi's own ffmpeg", () => {
    const runRoot = process.env[RUN_ROOT_ENV]!;
    for (const name of ["ffmpeg", "ffprobe"]) {
      const exe = process.platform === "win32" ? `${name}.exe` : name;
      expect(fs.existsSync(path.join(process.env.LIBI_HOME!, "bin", exe)), exe).toBe(fs.existsSync(path.join(runRoot, "bin", exe)));
    }
  });

  it("also gets its own CODEX_HOME inside its worker folder, not the run's shared one", () => {
    const home = process.env.LIBI_HOME!;
    expect(process.env.CODEX_HOME).toBe(path.join(home, "codex-home"));
    expect(fs.statSync(process.env.CODEX_HOME!).isDirectory()).toBe(true);
  });
});
