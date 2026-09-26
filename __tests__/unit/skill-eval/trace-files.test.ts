import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "@/scripts/skill-eval/assertions";
import { parseScenario } from "@/scripts/skill-eval/scenario";
import { CATALOG_CANARY, needsCatalogCanary, readCatalogCanary, readTrace, truncateTrace } from "@/scripts/skill-eval/harness";
import { FIXTURE_TRACE_FILE } from "@/lib/templates/cloud/test-fixture";

let home = "";
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the harness trace", () => {
  it("reads the templates catalog fixture's calls as provider templates-catalog, merged in time order", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    const dir = path.join(home, "test-mode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "fal-calls.jsonl"), `${JSON.stringify({ tool: "run_model", ts: "2026-09-23T00:00:02Z" })}\n`);
    fs.writeFileSync(
      path.join(dir, FIXTURE_TRACE_FILE),
      [
        { tool: "index", input: {}, status: 200, ts: "2026-09-23T00:00:01Z" },
        { tool: "report", input: { id: "aaaaaaaaaaaaaaaaaaa2", reason: "spam" }, status: 200, ts: "2026-09-23T00:00:03Z" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const trace = readTrace(home);
    expect(trace.map((c) => [c.tool, c.provider])).toEqual([
      ["index", "templates-catalog"],
      ["run_model", "fal"],
      ["report", "templates-catalog"],
    ]);
    const [r] = evaluate(trace, [{ provider: "templates-catalog", tool: "report", expect: "present" }]);
    expect(r.pass).toBe(true);
  });

  it("truncates the fixture's trace with the others before a run", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    const file = path.join(home, "test-mode", FIXTURE_TRACE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ tool: "use", ts: "x" })}\n`);
    truncateTrace(home);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(readTrace(home)).toEqual([]);
  });
});

/**
 * The catalog canary (T11). 04/05 assert `count: "==0"` on the catalog fixture — which a
 * recorder that stopped recording (or a studio that no longer reaches the fixture) would
 * also pass. So a scenario with any `provider: templates-catalog` assertion makes ONE
 * catalog read through the studio after its last turn, and asserts it was recorded.
 */
describe("the catalog canary", () => {
  const withCatalog = { assertions: [{ provider: "templates-catalog" as const, tool: "prepare", count: "==0" }] };
  const without = { assertions: [{ transcript_contains: "x", expect: "present" as const }] };
  const canary = { provider: "templates-catalog" as const, tool: CATALOG_CANARY.tool, count: ">=1" };

  type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  /** A stubbed studio: records every request, and — when `record` — traces the fixture read the real studio makes. */
  async function studio(opts: { status?: number; record?: boolean } = {}): Promise<{ base: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (opts.record !== false) {
        const dir = path.join(home, "test-mode");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, FIXTURE_TRACE_FILE), `${JSON.stringify({ ts: new Date().toISOString(), tool: "index", input: {}, status: 200 })}\n`);
      }
      res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: [], refreshed: true }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, seen };
  }

  it("is wanted exactly when a scenario asserts on the catalog fixture", () => {
    expect(needsCatalogCanary(withCatalog)).toBe(true);
    expect(needsCatalogCanary(without)).toBe(false);
    expect(needsCatalogCanary({ assertions: [] })).toBe(false);
  });

  it("reads the studio's catalog exactly once — a forced refresh, as a header-less internal client — and the read is traced", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    truncateTrace(home);
    const s = await studio();
    await expect(readCatalogCanary(s.base, withCatalog)).resolves.toEqual({ ran: true, ok: true, status: 200 });
    expect(s.seen.map((r) => [r.method, r.url])).toEqual([["POST", CATALOG_CANARY.path]]);
    expect(s.seen[0].headers["sec-fetch-site"]).toBeUndefined();
    expect(s.seen[0].headers.origin).toBeUndefined();
    const [r] = evaluate(readTrace(home), [canary]);
    expect(r.pass).toBe(true);
  });

  it("makes no request for a scenario that does not assert on the catalog", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    const s = await studio();
    await expect(readCatalogCanary(s.base, without)).resolves.toEqual({ ran: false });
    expect(s.seen).toEqual([]);
  });

  it("a dead recorder fails the canary: nothing traced, so `>=1` is not a PASS", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    truncateTrace(home);
    const s = await studio({ record: false });
    await readCatalogCanary(s.base, withCatalog);
    expect(s.seen).toHaveLength(1);
    const [r] = evaluate(readTrace(home), [canary]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('does not satisfy ">=1"');
  });

  it("never throws when the studio refuses or is gone — the canary assertion carries the verdict", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trace-"));
    const s = await studio({ status: 403, record: false });
    await expect(readCatalogCanary(s.base, withCatalog)).resolves.toEqual({ ran: true, ok: false, status: 403 });
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await expect(readCatalogCanary(s.base, withCatalog)).resolves.toMatchObject({ ran: true, ok: false, error: expect.any(String) });
    expect(evaluate(readTrace(home), [canary])[0].pass).toBe(false);
  });
});

describe("every scenario that asserts on the catalog carries the canary", () => {
  const root = path.join(process.cwd(), "skill-eval/scenarios");
  const files = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(root, f));

  it("04 and 05 are among them", () => {
    const withCatalog = files.filter((f) => needsCatalogCanary(parseScenario(fs.readFileSync(f, "utf8"), f))).map((f) => path.basename(f));
    expect(withCatalog).toEqual(expect.arrayContaining(["04-publish-template.md", "05-publish-without-skill.md"]));
  });

  it.each(files.filter((f) => /templates-catalog/.test(fs.readFileSync(f, "utf8"))))("%s asserts the canary read was recorded (>=1)", (f) => {
    const s = parseScenario(fs.readFileSync(f, "utf8"), f);
    expect(s.assertions).toContainEqual(expect.objectContaining({ provider: "templates-catalog", tool: CATALOG_CANARY.tool, count: ">=1" }));
  });
});

describe("templates-01's covers", () => {
  it("no longer claims show_templates, which the one-turn run only asserts is absent", () => {
    const f = path.join(process.cwd(), "skill-eval/scenarios/templates/01-create-from-piece.md");
    expect(parseScenario(fs.readFileSync(f, "utf8"), f).covers).not.toContain("show_templates");
  });
});
