import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";

let testDb: ReturnType<typeof createTestDb>;
let home: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

import { POST } from "@/app/api/e2e/seed-template/route";
import { getTemplate } from "@/lib/templates/store";

const FIXTURE = path.resolve(process.cwd(), "__tests__/helpers/fixtures/templates/lower-third");

describe("POST /api/e2e/seed-template", () => {
  beforeEach(() => {
    home = createTempStorageDir();
    testDb = createTestDb();
    process.env.LIBI_ENABLE_TEST_ROUTES = "1";
  });
  afterEach(() => {
    delete process.env.LIBI_ENABLE_TEST_ROUTES;
    resetTestDb();
    cleanupTempDir(home);
  });

  it("imports a fixture folder and returns its id", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ dir: FIXTURE }) }));
    expect(res.status).toBe(200);
    const { templateId } = await res.json();
    expect(getTemplate(templateId)?.name).toBe("Lower third");
  });
  it("refuses a dir outside the allowed roots, and is 403 when test routes are off", async () => {
    expect((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ dir: "/etc" }) }))).status).toBe(400);
    delete process.env.LIBI_ENABLE_TEST_ROUTES;
    expect((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ dir: FIXTURE }) }))).status).toBe(403);
  });

  /**
   * A folder inside an allowed root but carrying a scaffold `validateScaffold` rejects.
   * It must come back 400 with the validator's reason rather than a 500: the harness
   * throws on a failed seed, and "overlays.0.font: text overlay needs font" is what makes
   * that failure readable instead of a stack trace half a minute into a run.
   */
  it("is 400 with the validator's reason when the folder's scaffold is invalid", async () => {
    const dir = path.join(home, "fixtures", "templates", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify({ schema: 1, name: "Broken" }));
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ dir }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid scaffold/);
  });

  it("is 400 when template.json is missing altogether", async () => {
    const dir = path.join(home, "fixtures", "templates", "empty");
    fs.mkdirSync(dir, { recursive: true });
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ dir }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/template\.json missing/);
  });
});
