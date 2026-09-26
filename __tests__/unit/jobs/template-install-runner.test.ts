// __tests__/unit/jobs/template-install-runner.test.ts
//
// The template_install job: its params (the dedupe key), its registration, and
// how it drives the install — progress and a checkpoint per file, cancellation,
// and `discardOutput` as the only way to force a re-download. The install
// itself is tested on its own (__tests__/unit/templates/cloud/install.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const installTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/templates/cloud/install", () => ({ installTemplate }));

import { __resetRunnerRegistryForTests, getJobKindToToolIdsMap, getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { templateInstallRunner, type TemplateInstallParams, type TemplateInstallResult } from "@/lib/jobs/runners/template-install";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import type { TemplateInstallJobResult } from "@/mcp/tools/template-tools";
import type { InstallOptions } from "@/lib/templates/cloud/install";

const ID = "abcdefghijklmnopqrst";

function ctx(params: TemplateInstallParams, over: Partial<JobContext<TemplateInstallParams>> = {}) {
  return {
    jobId: "job-1",
    params,
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => undefined),
    shouldCancel: vi.fn(() => false),
    ...over,
  } satisfies JobContext<TemplateInstallParams>;
}

afterEach(() => {
  installTemplate.mockReset();
  __resetRunnerRegistryForTests();
});

describe("template_install runner", () => {
  it("is registered, drives libi.apply_template's progress row, and owns one install per template", () => {
    registerBuiltinRunners();
    expect(getRunner("template_install")).toBe(templateInstallRunner);
    expect(getJobKindToToolIdsMap().get("template_install")).toEqual(["libi:libi.apply_template"]);
    expect(templateInstallRunner.exclusiveResource).toBe(true);
  });

  it("takes { cloudId, version? } and nothing else — no transient value can split the dedupe key", () => {
    const schema = templateInstallRunner.paramsSchema;
    expect(schema.parse({ cloudId: ID })).toEqual({ cloudId: ID });
    expect(schema.parse({ cloudId: ID, version: 3 })).toEqual({ cloudId: ID, version: 3 });
    for (const bad of [{ cloudId: ID, force: true }, { cloudId: ID, toolCallId: "t1" }, { cloudId: "../etc" }, { cloudId: ID, version: 0 }, {}]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("reports progress and checkpoints once per verified file, and returns the installed template", async () => {
    installTemplate.mockImplementation(async (_id: string, opts: InstallOptions) => {
      await opts.onFile?.({ name: "template.json", index: 1, count: 2, doneBytes: 25, totalBytes: 100 });
      await opts.onFile?.({ name: "example.mp4", index: 2, count: 2, doneBytes: 100, totalBytes: 100 });
      return { ok: true, templateId: "t1", version: 2, reinstalled: false };
    });
    const c = ctx({ cloudId: ID, version: 2 });
    const r = await templateInstallRunner.run(c);
    expect(r).toEqual({ templateId: "t1", version: 2, reinstalled: false });
    expect(installTemplate).toHaveBeenCalledWith(ID, expect.objectContaining({ version: 2, force: false, signal: expect.any(AbortSignal) }));
    expect(c.reportProgress).toHaveBeenCalledWith(25, 100, "%");
    expect(c.reportProgress).toHaveBeenCalledWith(100, 100, "%");
    expect(vi.mocked(c.checkpoint).mock.calls.map((call) => call[0])).toEqual([
      { step: "downloaded", file: "template.json", files: 1, of: 2 },
      { step: "downloaded", file: "example.mp4", files: 2, of: 2 },
    ]);
  });

  it("re-downloads only when the caller asked to discard what is on disk", async () => {
    installTemplate.mockResolvedValue({ ok: true, templateId: "t1", version: 1, reinstalled: true });
    await templateInstallRunner.run(ctx({ cloudId: ID }, { forced: true }));
    expect(installTemplate).toHaveBeenLastCalledWith(ID, expect.objectContaining({ force: false }));
    await templateInstallRunner.run(ctx({ cloudId: ID }, { discardOutput: true }));
    expect(installTemplate).toHaveBeenLastCalledWith(ID, expect.objectContaining({ force: true }));
  });

  it("fails the job with the install's own reason, and its code for the Templates page", async () => {
    installTemplate.mockResolvedValue({ ok: false, error: "This template is no longer in the catalog (removed or hidden).", code: "not_found" });
    const run = templateInstallRunner.run(ctx({ cloudId: ID }));
    await expect(run).rejects.toThrow("This template is no longer in the catalog (removed or hidden).");
    await expect(run).rejects.toMatchObject({ name: "TemplateInstallError", code: "not_found" });
  });

  it("a cancel stops the download and ends the job cancelled", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      installTemplate.mockImplementation(
        (_id: string, opts: InstallOptions) =>
          new Promise((resolve) => opts.signal!.addEventListener("abort", () => resolve({ ok: false, error: "the install was stopped", code: "stopped" }))),
      );
      const run = templateInstallRunner.run(ctx({ cloudId: ID }, { shouldCancel: () => cancelled }));
      const settled = expect(run).rejects.toBeInstanceOf(CancelledError);
      cancelled = true;
      await vi.advanceTimersByTimeAsync(600);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the MCP side's copy of the result type carries the same keys", () => {
    const fromRunner: TemplateInstallResult = { templateId: "t", version: 1, reinstalled: false };
    const onWire: TemplateInstallJobResult = fromRunner;
    expect(Object.keys(onWire).sort()).toEqual(["reinstalled", "templateId", "version"]);
  });
});
