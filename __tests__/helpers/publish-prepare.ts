// __tests__/helpers/publish-prepare.ts
//
// `libi.publish_template` in a unit test: its prepare job run in-process (the
// real `template_publish_prepare` runner, where production reaches it over
// HTTP), with ffmpeg replaced by a deterministic stand-in whose output is
// derived from the source's bytes — so a test can tell exactly which bytes a
// request holds, and see that a later change to the source changes nothing.
//
// Use from a test file (vi.mock is hoisted, so the factories import this lazily):
//
//   vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
//   vi.mock("@/mcp/jobs-client", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.inProcessJobsClient()));
import fs from "node:fs";
import { vi } from "vitest";

/** The example the stand-in "transcodes" from `source`: a prefix plus the source's bytes. */
export function exampleBytesFor(source: Buffer): Buffer {
  return Buffer.concat([Buffer.from("EXAMPLE:"), source]);
}
/** The poster the stand-in makes from `source`. */
export function posterBytesFor(source: Buffer): Buffer {
  return Buffer.concat([Buffer.from("POSTER:"), source]);
}

export function fakePublishMedia() {
  return {
    EXAMPLE_OP: "template_example",
    POSTER_OP: "template_poster",
    transcodeExample: vi.fn(async (input: string, output: string) => {
      const bytes = exampleBytesFor(fs.readFileSync(input));
      fs.writeFileSync(output, bytes);
      return { path: output, bytes: bytes.byteLength, durationSec: 3, width: 720, height: 1280 };
    }),
    makePoster: vi.fn(async (input: string, output: string) => {
      const bytes = posterBytesFor(fs.readFileSync(input));
      fs.writeFileSync(output, bytes);
      return { path: output, bytes: bytes.byteLength };
    }),
    readBackExample: vi.fn(async (file: string) => ({ path: file, bytes: fs.statSync(file).size, durationSec: 3, width: 720, height: 1280 })),
  };
}

/** Every prepare the tool asked for, in order. */
export const prepareCalls: Array<{ kind: string; params: unknown }> = [];

/**
 * The jobs client, answering `template_publish_prepare` by running the real
 * runner in this process; any other kind fails the test.
 */
export function inProcessJobsClient() {
  class LibiServerUnavailableError extends Error {
    readonly hint = "start libi";
  }
  return {
    LibiServerUnavailableError,
    runJobViaServer: vi.fn(async (kind: string, params: unknown) => {
      if (kind !== "template_publish_prepare") throw new Error(`the tool ran an unexpected job: ${kind}`);
      prepareCalls.push({ kind, params });
      const { templatePublishPrepareRunner } = await import("@/lib/jobs/runners/template-publish-prepare");
      const parsed = templatePublishPrepareRunner.paramsSchema.parse(params);
      const result = await templatePublishPrepareRunner.run({
        jobId: `prepare-${prepareCalls.length}`,
        params: parsed,
        resumeState: null,
        reportProgress: () => undefined,
        checkpoint: async () => undefined,
        shouldCancel: () => false,
      } as never);
      return { status: "new", jobId: `prepare-${prepareCalls.length}`, result };
    }),
  };
}
