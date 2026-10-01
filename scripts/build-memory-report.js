#!/usr/bin/env node
/**
 * How close did the macOS shell build come to its memory ceiling?
 *
 *   node scripts/build-memory-report.js "$RUNNER_TEMP/build-time.txt"
 *
 * WHY. 0.1.16's `next build` worker died "JavaScript heap out of memory" twice
 * on the 7 GB macos-15 runner, while the same build passed on the 16 GB ubuntu
 * and windows runners. cf7ad01f gave it `--max-old-space-size=5120`, and
 * nobody knew how much room that left — so the next dependency bump would find
 * the new ceiling on a real release run. release-electron.yml now runs the mac
 * build under `/usr/bin/time -l -o <file>`, and this reads that file.
 *
 * WHAT IT MEASURES. `time -l` reports the rusage of the process it waited
 * for, whose `maximum resident set size` is the peak of the LARGEST single
 * process in the tree — not a sum. That is the `next build` worker, the one
 * that died, which is exactly the number that matters here.
 *
 * VERDICT. Two ceilings, and the tighter one decides:
 *   - heap:     the V8 heap limit (`--max-old-space-size`, 5 GiB) − peak RSS.
 *               0.1.16 died on THIS one ("JavaScript heap out of memory"), not
 *               on physical RAM. RSS ≥ heap used, so this bound is conservative.
 *   - physical: runner RAM − what macOS and the runner agent keep for
 *               themselves (OS_RESERVE_BYTES, 1 GiB) − peak RSS. It binds only
 *               if the heap limit is ever raised past what the runner can hold.
 * Under 1.5 GB of the smaller headroom prints a `::warning::`; under 1 GB an
 * `::error::` and exit 1. In the workflow the step is `continue-on-error` on a
 * REAL run, so it fails a dry run (the point: find the ceiling on a rehearsal)
 * but never withholds the Release after a good, notarized build. The owner
 * decision if it trips is O8 in the release plan (a larger runner costs money).
 * No measurement at all (the build died before `time` wrote, or the file is
 * unreadable) is a warning, never a verdict — the build step's own failure is
 * already the red signal then.
 *
 * "GB" here is 2^30 bytes throughout, so a 5120 MB heap reads as 5.0 GB and
 * the runner as 7 GB, matching how GitHub and Node size them.
 */
const { appendFileSync, readFileSync } = require("node:fs");
const os = require("node:os");

const GB = 2 ** 30;
/** What macOS itself and the runner agent keep; the build never gets it. */
const OS_RESERVE_BYTES = 1 * GB;
const WARN_BELOW_BYTES = 1.5 * GB;
const ERROR_BELOW_BYTES = 1 * GB;

/**
 * The `maximum resident set size` from macOS `/usr/bin/time -l` output, in
 * bytes (macOS reports bytes; Linux's GNU time reports kilobytes in another
 * format entirely, which is not accepted here). null when absent.
 *
 * @param {string | null | undefined} text
 * @returns {number | null}
 */
function parseMaxRss(text) {
  if (typeof text !== "string") return null;
  const m = /^\s*(\d+)\s+maximum resident set size\s*$/m.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {number} peakBytes         peak RSS of the largest process
 * @param {number} runnerBytes       the runner's physical memory
 * @param {number | null} [heapBytes] the V8 heap limit, when one is set
 * @returns {{
 *   level: "ok" | "warning" | "error",
 *   headroomBytes: number,
 *   physicalHeadroomBytes: number,
 *   heapHeadroomBytes: number | null,
 *   binding: "heap" | "physical",
 * }}
 */
function verdict(peakBytes, runnerBytes, heapBytes = null) {
  const physicalHeadroomBytes = runnerBytes - OS_RESERVE_BYTES - peakBytes;
  const heapHeadroomBytes = heapBytes ? heapBytes - peakBytes : null;
  const binding =
    heapHeadroomBytes !== null && heapHeadroomBytes < physicalHeadroomBytes ? "heap" : "physical";
  const headroomBytes = binding === "heap" ? heapHeadroomBytes : physicalHeadroomBytes;
  const level =
    headroomBytes < ERROR_BELOW_BYTES ? "error" : headroomBytes < WARN_BELOW_BYTES ? "warning" : "ok";
  return { level, headroomBytes, physicalHeadroomBytes, heapHeadroomBytes, binding };
}

/** `--max-old-space-size=<MB>` from a NODE_OPTIONS string, in bytes. */
function heapLimitBytes(nodeOptions) {
  const m = /--max-old-space-size=(\d+)/.exec(nodeOptions ?? "");
  return m ? Number(m[1]) * 2 ** 20 : null;
}

const gb = (bytes) => (bytes / GB).toFixed(1);

/** The one line that goes into the job summary. */
function formatReport({ peakBytes, runnerBytes, heapBytes }) {
  const v = verdict(peakBytes, runnerBytes, heapBytes);
  const parts = [
    v.heapHeadroomBytes !== null ? `heap ${gb(v.heapHeadroomBytes)} GB` : "heap n/a",
    `physical ${gb(v.physicalHeadroomBytes)} GB`,
  ];
  return (
    `peak RSS ${gb(peakBytes)} GB of ${Math.round(runnerBytes / GB)} GB runner; ` +
    `heap limit ${heapBytes ? `${gb(heapBytes)} GB` : "Node default"}; ` +
    `headroom ${gb(v.headroomBytes)} GB (${parts.join(", ")}; ${v.binding} binds)`
  );
}

/** Physical memory of this machine; LIBI_RUNNER_MEMORY_BYTES overrides (tests). */
function runnerBytes() {
  const override = Number(process.env.LIBI_RUNNER_MEMORY_BYTES);
  return Number.isFinite(override) && override > 0 ? override : os.totalmem();
}

function main(argv) {
  const file = argv[0];
  const summary = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  let text = null;
  try {
    text = file ? readFileSync(file, "utf8") : null;
  } catch {
    text = null;
  }
  const peakBytes = parseMaxRss(text);
  if (peakBytes === null) {
    console.log(
      `::warning title=mac build memory::no memory measurement in ${file ?? "(no file given)"} - ` +
        "the build likely failed before /usr/bin/time wrote it; see the build step.",
    );
    summary("**macOS build memory:** no measurement (see the build step).");
    return 0;
  }
  const runner = runnerBytes();
  const heapBytes = heapLimitBytes(process.env.NODE_OPTIONS);
  const line = formatReport({ peakBytes, runnerBytes: runner, heapBytes });
  const { level } = verdict(peakBytes, runner, heapBytes);
  summary(
    `**macOS build memory:** ${line}. Headroom is the smaller of heap limit − peak and ` +
      `runner − ${gb(OS_RESERVE_BYTES)} GB kept by macOS − peak; ` +
      "warning under 1.5 GB, failure under 1 GB (release plan O8).",
  );
  if (level === "error") {
    console.log(
      `::error title=mac build memory::${line} - under 1 GB left. The next dependency bump ` +
        "can run the next build worker out of memory on a real release; decide O8 (a larger runner) first.",
    );
    return 1;
  }
  if (level === "warning") {
    console.log(`::warning title=mac build memory::${line} - under 1.5 GB left.`);
  }
  return 0;
}

module.exports = {
  OS_RESERVE_BYTES,
  parseMaxRss,
  verdict,
  heapLimitBytes,
  formatReport,
  runnerBytes,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
