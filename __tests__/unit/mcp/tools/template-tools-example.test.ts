// __tests__/unit/mcp/tools/template-tools-example.test.ts
//
// D4: `libi.create_template_from_piece` starts the template's example render
// (the `template_example` job) in the background, once the template exists —
// and never waits on it, nor fails because of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { cleanupTempDir, createTempStorageDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { seedTemplateFixturePiece } from "@/__tests__/helpers/template-fixture-piece";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
const enqueueJobOnServer = vi.hoisted(() => vi.fn());
const Unavailable = vi.hoisted(() => class LibiServerUnavailableError extends Error {});
vi.mock("@/mcp/jobs-client", () => ({
  runJobViaServer: vi.fn(),
  enqueueJobOnServer,
  LibiServerUnavailableError: Unavailable,
  logProxyGenEnqueueFailure: () => {},
}));
vi.mock("@/mcp/analytics", () => ({
  trackMcpEvent: vi.fn(),
  trackToolUsed: vi.fn(),
  trackMcpMilestone: vi.fn(),
  wrapRegisterToolWithTracking: (s: unknown) => s,
  trackCliSessionOpened: vi.fn(),
}));
vi.mock("@/mcp/notify", () => ({ notify: { navigateTemplates: vi.fn(async () => true), navigateAwaited: vi.fn(async () => true), navigate: vi.fn(), refreshQuery: vi.fn() } }));
vi.mock("@/lib/templates/cloud/client", () => ({ fetchIndex: vi.fn(async () => ({ ok: false, error: "offline", reason: "unreachable" })) }));

import { mcpLogger } from "@/lib/logger";
import { notify } from "@/mcp/notify";
import { createTemplateFromPiece } from "@/mcp/tools/template-tools";
import { getTemplate } from "@/lib/templates/store";

let pieceId = "";
beforeEach(async () => {
  storageDir = createTempStorageDir();
  testDb = createTestDb();
  ({ pieceId } = await seedTemplateFixturePiece(testDb as never, storageDir));
  enqueueJobOnServer.mockReset();
  vi.mocked(notify.refreshQuery).mockClear();
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir(storageDir);
  vi.restoreAllMocks();
});

const create = () => createTemplateFromPiece({ pieceId, name: "Lower third", description: "A name card" });

describe("create_template_from_piece — the example render", () => {
  it("enqueues template_example for the new template, after its row exists", async () => {
    enqueueJobOnServer.mockImplementation(async (_kind: string, params: { templateId: string }) => {
      // The row is there by the time the job is asked for.
      expect(getTemplate(params.templateId)).not.toBeNull();
      return { status: "new", jobId: "j", clientKey: "k" };
    });
    const r = await create();
    expect(r.success).toBe(true);
    const templateId = (r.data as { templateId: string }).templateId;
    // Keyed by the template alone, and scoped to no piece: a job row scoped to the
    // source piece would be deleted with it (FK cascade) under a live runner.
    expect(enqueueJobOnServer).toHaveBeenCalledWith("template_example", { templateId }, {});
  });

  it("re-reads the Templates page once the job exists, so the card names the render (review M2)", async () => {
    let resolveEnqueue: (v: unknown) => void = () => {};
    enqueueJobOnServer.mockImplementation(() => new Promise((r) => (resolveEnqueue = r)));
    const r = await create();
    expect(r.success).toBe(true);
    // The tool's own `templates` refresh (mcp/server.ts) fires on its answer — before the job row exists.
    expect(notify.refreshQuery).not.toHaveBeenCalled();
    resolveEnqueue({ status: "new", jobId: "j", clientKey: "k" });
    await vi.waitFor(() => expect(notify.refreshQuery).toHaveBeenCalledWith({ queryKey: "templates" }));
  });

  it("an unreachable server is logged and the tool still succeeds", async () => {
    const warn = vi.spyOn(mcpLogger, "warn");
    enqueueJobOnServer.mockRejectedValue(new Unavailable("failed to reach libi server"));
    const r = await create();
    expect(r.success).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "templates", op: "example_enqueue_failed" }), expect.any(String)));
    expect(notify.refreshQuery).not.toHaveBeenCalled();
  });

  it("does not wait for the job", async () => {
    enqueueJobOnServer.mockImplementation(() => new Promise(() => {}));
    const r = await create();
    expect(r.success).toBe(true);
  });
});
