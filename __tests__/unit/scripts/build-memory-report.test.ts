// `scripts/build-memory-report.js` — how close the macOS shell build came to
// its memory ceiling. 0.1.16's `next build` worker ran out of heap twice on
// the 7 GB macos-15 runner; cf7ad01f raised the heap to 5 GB, and nobody
// knew how much room that left. The mac job now runs the build under
// `/usr/bin/time -l` and this script turns its output into one summary line,
// a ::warning:: under 1.5 GB of headroom, and a failure under 1 GB.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseMaxRss,
  verdict,
  heapLimitBytes,
  formatReport,
  OS_RESERVE_BYTES,
} from "@/scripts/build-memory-report.js";

const GB = 2 ** 30;
const RUNNER = 7 * GB;

// Verbatim shape of macOS `/usr/bin/time -l` output.
const TIME_L = `        612.34 real       901.12 user        88.20 sys
          5368709120  maximum resident set size
                   0  average shared memory size
                   0  average unshared data size
                   0  average unshared stack size
             1532364  page reclaims
                 730  page faults
                   0  swaps
         43880016900  instructions retired
          4214632512  peak memory footprint
`;

describe("parseMaxRss", () => {
  it("reads macOS time -l output as bytes", () => {
    expect(parseMaxRss(TIME_L)).toBe(5368709120);
    expect(parseMaxRss("  5368709120  maximum resident set size")).toBe(5368709120);
  });

  it("does not confuse peak memory footprint for the RSS", () => {
    expect(parseMaxRss(TIME_L)).not.toBe(4214632512);
  });

  it("returns null on garbage", () => {
    expect(parseMaxRss("")).toBeNull();
    expect(parseMaxRss("Killed: 9")).toBeNull();
    expect(parseMaxRss("maximum resident set size")).toBeNull();
    expect(parseMaxRss(null)).toBeNull();
  });
});

describe("verdict", () => {
  // Controller decision (review I-2): headroom is the SMALLER of two, because
  // 0.1.16 died on the V8 heap limit, not on physical RAM. The brief's
  // original examples (5.2e9 → warning) were computed against RAM alone; under
  // the 5 GiB heap 5.2e9 RSS leaves ~0.16 GB, which is an error.
  const HEAP = 5 * GB;

  it("ok with room under both ceilings", () => {
    expect(verdict(3e9, RUNNER, HEAP).level).toBe("ok");
  });

  it("warns under 1.5 GB of heap headroom", () => {
    const v = verdict(4.0e9, RUNNER, HEAP);
    expect(v.level).toBe("warning");
    expect(v.binding).toBe("heap");
  });

  it("errors under 1 GB — 5.2e9 against a 5 GiB heap is an error now", () => {
    expect(verdict(5.2e9, RUNNER, HEAP).level).toBe("error");
    expect(verdict(6.3e9, RUNNER, HEAP).level).toBe("error");
  });

  it("reports both headrooms and which one binds", () => {
    const v = verdict(3e9, RUNNER, HEAP);
    expect(v.heapHeadroomBytes).toBe(HEAP - 3e9);
    expect(v.physicalHeadroomBytes).toBe(RUNNER - OS_RESERVE_BYTES - 3e9);
    expect(v.headroomBytes).toBe(Math.min(v.heapHeadroomBytes!, v.physicalHeadroomBytes));
    expect(OS_RESERVE_BYTES).toBe(1 * GB);
  });

  it("physical binds when the heap limit is above what the runner can hold", () => {
    const v = verdict(5.2e9, RUNNER, 8 * GB);
    expect(v.binding).toBe("physical");
    expect(v.level).toBe("warning");
  });

  it("with no heap limit set, only the physical ceiling counts", () => {
    const v = verdict(5.2e9, RUNNER);
    expect(v.heapHeadroomBytes).toBeNull();
    expect(v.binding).toBe("physical");
    expect(v.level).toBe("warning");
  });
});

describe("heapLimitBytes", () => {
  it("reads --max-old-space-size from NODE_OPTIONS", () => {
    expect(heapLimitBytes("--max-old-space-size=5120")).toBe(5 * GB);
    expect(heapLimitBytes("--trace-warnings --max-old-space-size=4096")).toBe(4 * GB);
  });

  it("is null when no limit is set", () => {
    expect(heapLimitBytes("")).toBeNull();
    expect(heapLimitBytes(undefined)).toBeNull();
  });
});

describe("formatReport", () => {
  it("says peak, runner, heap limit and headroom in one line", () => {
    const line = formatReport({ peakBytes: 4.0e9, runnerBytes: RUNNER, heapBytes: 5 * GB });
    expect(line).toBe(
      "peak RSS 3.7 GB of 7 GB runner; heap limit 5.0 GB; headroom 1.3 GB " +
        "(heap 1.3 GB, physical 2.3 GB; heap binds)",
    );
  });

  it("says when no heap limit is set", () => {
    const line = formatReport({ peakBytes: 3e9, runnerBytes: RUNNER, heapBytes: null });
    expect(line).toContain("heap limit Node default");
    expect(line).toContain("heap n/a");
  });
});

describe("the CLI", () => {
  function run(timeOutput: string | null, extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-report-"));
    const file = path.join(dir, "build-time.txt");
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    if (timeOutput !== null) writeFileSync(file, timeOutput);
    try {
      const r = spawnSync(process.execPath, ["scripts/build-memory-report.js", file], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          NODE_OPTIONS: "--max-old-space-size=5120",
          LIBI_RUNNER_MEMORY_BYTES: String(RUNNER),
          ...extraEnv,
        },
      });
      return { status: r.status, out: r.stdout + r.stderr, summary: readFileSync(summary, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("ok: exit 0, one summary line, no annotation", () => {
    const r = run("  3000000000  maximum resident set size\n");
    expect(r.status).toBe(0);
    expect(r.summary).toContain(
      "peak RSS 2.8 GB of 7 GB runner; heap limit 5.0 GB; headroom 2.2 GB (heap 2.2 GB, physical 3.2 GB; heap binds)",
    );
    expect(r.out).not.toMatch(/::(warning|error)::/);
  });

  it("under 1.5 GB: exit 0 with a ::warning::", () => {
    const r = run("  4000000000  maximum resident set size\n");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^::warning[^\n]*::/m);
  });

  it("under 1 GB: exit 1 with an ::error::", () => {
    const r = run("  5200000000  maximum resident set size\n");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^::error[^\n]*::/m);
    expect(r.summary).toMatch(/headroom 0\.2 GB \(heap 0\.2 GB, physical 1\.2 GB; heap binds\)/);
  });

  it("no measurement (the build died first, or time printed nothing): a warning, not a verdict", () => {
    for (const r of [run(null), run("garbage")]) {
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/^::warning[^\n]*::.*no memory measurement/m);
    }
  });

  it("reads the real runner's memory when no override is given", () => {
    // Smoke: the default path must not throw on this machine.
    const out = execFileSync(
      process.execPath,
      ["-e", "console.log(require('./scripts/build-memory-report.js').runnerBytes() > 0)"],
      { encoding: "utf8", env: { ...process.env, LIBI_RUNNER_MEMORY_BYTES: "" } },
    );
    expect(out.trim()).toBe("true");
  });
});
