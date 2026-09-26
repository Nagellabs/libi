import { describe, it, expect, vi } from "vitest";

/**
 * Spec §4.10 named settings/data-folder, settings/skills and terminal/shell-flavor
 * as "GET routes that write". Read against the code they do not: their writes
 * live on POST (data-folder, skills) or nowhere (shell-flavor). The request
 * guard allows every loopback GET (its Host is checked, its Sec-Fetch-Site and
 * Origin are not), so a GET that wrote would be an unguarded mutation that any
 * cross-site page could fire — this test is the tripwire that keeps it that way.
 */
const fsWrites = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn(), renameSync: vi.fn(), rmSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), ...fsWrites }));
vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs")>()), ...fsWrites, default: { ...(await importOriginal<typeof import("fs")>()), ...fsWrites } }));
const fsPromiseWrites = vi.hoisted(() => ({ writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, ...fsPromiseWrites, default: { ...real, ...fsPromiseWrites } };
});
vi.mock("fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs/promises")>();
  return { ...real, ...fsPromiseWrites, default: { ...real, ...fsPromiseWrites } };
});
const dbWrites = vi.hoisted(() => ({ insert: vi.fn(), update: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ all: () => [], where: () => ({ all: () => [] }) }) }), ...dbWrites }),
}));

import { GET as dataFolderGet } from "@/app/api/settings/data-folder/route";
import { GET as skillsGet } from "@/app/api/settings/skills/route";
import { GET as shellFlavorGet } from "@/app/api/terminal/shell-flavor/route";

describe("GET handlers the request guard lets through from any loopback caller never write", () => {
  it.each([
    ["settings/data-folder", dataFolderGet],
    ["settings/skills", skillsGet],
    ["terminal/shell-flavor", shellFlavorGet],
  ])("%s GET touches no filesystem write and no DB mutation", async (_name, handler) => {
    for (const spy of [...Object.values(fsWrites), ...Object.values(fsPromiseWrites), ...Object.values(dbWrites)]) spy.mockClear();
    const res = await handler();
    expect(res.status).toBe(200);
    for (const [name, spy] of Object.entries(fsWrites)) expect(spy, `fs.${name}`).not.toHaveBeenCalled();
    for (const [name, spy] of Object.entries(fsPromiseWrites)) expect(spy, `fs/promises.${name}`).not.toHaveBeenCalled();
    for (const [name, spy] of Object.entries(dbWrites)) expect(spy, `db.${name}`).not.toHaveBeenCalled();
  });
});
