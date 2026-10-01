/**
 * The test-mode catalog fixture (lib/templates/cloud/test-fixture.ts) against
 * the REAL cloud client and install, over real loopback HTTP: a tiny server
 * hands every `/api/test-mode/templates-catalog/*` request to
 * `handleFixtureRequest`, exactly as the Next route does, on the port the
 * client reads as the studio's. What passes here passes the client's own
 * response schemas and the install's byte checks — the fixture cannot drift
 * into a shape only a unit test accepts.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { extractFrameRgba, hasFfmpeg, sampleRegionMean } from "@/__tests__/helpers/media";

vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));

import {
  PUBLISH_ERROR_CODES,
  applyAsCreator,
  creatorStatus,
  fetchIndex,
  fetchMine,
  getCloudTemplate,
  publishCommit,
  publishPrepare,
  reportTemplate,
  reportUse,
  setNickname,
  setTemplateHidden,
  uploadSigned,
  type PublishErrorCode,
} from "@/lib/templates/cloud/client";
import { installTemplate } from "@/lib/templates/cloud/install";
import {
  FIXTURE_CLOUD_IDS,
  FIXTURE_LEFT_OUT_AUTHOR_VALUES,
  FIXTURE_LEFT_OUT_CLOUD_ID,
  FIXTURE_LEFT_OUT_NAME,
  FIXTURE_LEFT_OUT_TAGS,
  FIXTURE_CODE_STATUS,
  FIXTURE_TRACE_FILE,
  __resetFixtureCatalogForTests,
  getFixtureCatalog,
  handleFixtureRequest,
  injectFixtureFault,
} from "@/lib/templates/cloud/test-fixture";
import { SCAFFOLD_SCHEMA_SHA256 } from "@/lib/templates/scaffold-schema";
import { CREATOR_NOT_APPROVED_RENAME_MESSAGE, MODERATION_REASON_LABELS, MODERATION_REASONS } from "@/lib/templates/cloud/constants";
import { serverLogger } from "@/lib/logger";
import { getTemplate, readTemplateFile } from "@/lib/templates/store";
import { leftOutList, neutraliseOverlay, newNeutraliseContext } from "@/lib/templates/author-text";
import { authorTermStems } from "@/scripts/skill-eval/author-terms";

const KEY = "k".repeat(43);
const OTHER_KEY = "o".repeat(43);
const PREFIX = "/api/test-mode/templates-catalog/";

// --- a loopback server that is the Next route, minus Next --------------------

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(PREFIX)) {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const r = await handleFixtureRequest(req.method ?? "GET", decodeURIComponent(url.pathname.slice(PREFIX.length)), Buffer.concat(chunks), headers);
      res.writeHead(r.status, r.headers).end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "libi-fixture-"));
  vi.stubEnv("LIBI_TEST_MODE", "1");
  vi.stubEnv("LIBI_HOME", home);
  vi.stubEnv("LIBI_SERVER_PORT", String(port));
  createTestDb();
});
afterEach(() => {
  __resetFixtureCatalogForTests();
  resetTestDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

// --- helpers -------------------------------------------------------------------

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const h = body === undefined || Buffer.isBuffer(body) ? headers : { "content-type": "application/json", ...headers };
  return handleFixtureRequest(method, p, buf, h);
}
const bearer = (key = KEY) => ({ authorization: `Bearer ${key}` });
const jsonOf = (r: { body: Buffer }) => JSON.parse(r.body.toString("utf8")) as Record<string, unknown>;
const md5 = (b: Buffer) => createHash("md5").update(b).digest("base64");

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

/** A publish body the site accepts, and the bytes to upload for it. */
function publishBody(over: { name?: string; instructions?: string } = {}) {
  const scaffold = makeScaffold(over.name ? { name: over.name } : {});
  const instructions = over.instructions ?? "# Purpose\nA hook.\n";
  const bytes = new Map<string, Buffer>([
    ["template.json", Buffer.from(JSON.stringify(scaffold))],
    ["index.md", Buffer.from(instructions)],
    ["poster.jpg", JPG],
    ["example.mp4", MP4],
  ]);
  const type = { "template.json": "application/json", "index.md": "text/markdown", "poster.jpg": "image/jpeg", "example.mp4": "video/mp4" } as Record<string, string>;
  const body = {
    name: scaffold.name,
    description: scaffold.description,
    tags: scaffold.tags,
    scaffold,
    instructions,
    files: [...bytes].map(([name, b]) => ({ name, bytes: b.byteLength, contentType: type[name], md5: md5(b) })),
    example: { durationSec: 3, width: 720, height: 1280 },
  };
  return { body, bytes };
}

/** prepare → PUT every file → commit, through the real client. */
async function publish(key = KEY, over: Parameters<typeof publishBody>[0] = {}, templateId?: string) {
  const { body, bytes } = publishBody(over);
  const withId = templateId ? { ...body, templateId } : body;
  const prep = await publishPrepare(key, withId);
  if (!prep.ok) throw new Error(`prepare refused: ${prep.error}`);
  for (const up of prep.uploads) expect(await uploadSigned(up, bytes.get(up.name)!)).toEqual({ ok: true });
  const commitBody = { ...withId, templateId: prep.templateId, version: prep.version };
  return { prep, commitBody, commit: await publishCommit(key, commitBody) };
}

function trace(): Array<{ tool: string; input: Record<string, unknown>; status: number; code?: string }> {
  const file = path.join(home, "test-mode", FIXTURE_TRACE_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

// --- browse and install ----------------------------------------------------------

describe("the seeded catalog", () => {
  it("serves a gzipped index of three templates whose media resolve under the fixture bucket", async () => {
    const r = await api("GET", "index");
    expect(r.status).toBe(200);
    expect(r.headers["Content-Encoding"]).toBe("gzip");
    const index = JSON.parse(gunzipSync(r.body).toString());
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual([...FIXTURE_CLOUD_IDS]);
    expect(index.base).toBe(`http://127.0.0.1:${port}/api/test-mode/templates-catalog/bucket/`);
    const poster = await api("GET", `bucket/${index.entries[0].poster}`);
    expect(poster.status).toBe(200);
    expect([...poster.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const video = await api("GET", `bucket/${index.entries[0].video}`);
    expect(video.body.subarray(4, 8).toString("latin1")).toBe("ftyp");
    // A matching If-None-Match is a 304, like the site's generation ETag.
    expect((await api("GET", "index", undefined, { "if-none-match": r.headers.ETag })).status).toBe(304);
  });

  it("passes the real client: fetchIndex keeps all three, getCloudTemplate reads each", async () => {
    const idx = await fetchIndex({ etag: null });
    expect(idx.ok && !idx.notModified && idx.index.entries.map((e) => e.id)).toEqual([...FIXTURE_CLOUD_IDS]);
    for (const id of FIXTURE_CLOUD_IDS) {
      const t = await getCloudTemplate(id);
      expect(t.ok, id).toBe(true);
    }
  });

  it("serves stored bytes with the same hardened headers as libi's own media routes", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    const poster = await api("GET", `bucket/templates/${id}/v1/poster.jpg`);
    expect(poster.headers).toMatchObject({ "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" });
    // Not a media type: never inline from libi's origin.
    const md = await api("GET", `bucket/templates/${id}/v1/index.md`);
    expect(md.headers).toMatchObject({ "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    expect(md.headers["Content-Disposition"]).toMatch(/^attachment/);
    expect((await api("GET", `bucket/templates/${id}/v9/poster.jpg`)).status).toBe(404);
  });

  it("installs a seeded template end to end through the real install", async () => {
    const r = await installTemplate(FIXTURE_CLOUD_IDS[1]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(getTemplate(r.templateId)).toMatchObject({ origin: "installed", cloudId: FIXTURE_CLOUD_IDS[1], version: 1, name: "Red caption" });
    expect(trace().map((t) => t.tool)).toContain("get");
  });
});

// TPL-1: the site sends uses30d and lastUsedDay on a template's public shape
// (libi-site lib/templates/shape.ts#shapePublicTemplate); the fixture used to stop at
// usesTotal/uses7d, so test mode could never exercise the 30-day usage panel.
describe("uses30d and lastUsedDay on the template shape", () => {
  const DAY_MS = 86_400_000;
  const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

  it("a template used 3 and 20 days ago reports uses7d 1, uses30d 2, and the more recent day as lastUsedDay", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    const now = Date.now();
    const doc = getFixtureCatalog().entries.get(id)!;
    doc.uses = { total: 2, byDay: { [dayKeyOf(now - 3 * DAY_MS)]: 1, [dayKeyOf(now - 20 * DAY_MS)]: 1 } };

    const t = (jsonOf(await api("GET", id)) as { template: Record<string, unknown> }).template;
    expect(t.uses7d).toBe(1);
    expect(t.uses30d).toBe(2);
    expect(t.lastUsedDay).toBe(new Date(now - 3 * DAY_MS).toISOString().slice(0, 10));
  });

  it("a never-used template reports uses30d 0 and lastUsedDay null", async () => {
    const [, , id] = FIXTURE_CLOUD_IDS;
    const doc = getFixtureCatalog().entries.get(id)!;
    doc.uses = { total: 0, byDay: {} };
    const t = (jsonOf(await api("GET", id)) as { template: Record<string, unknown> }).template;
    expect(t.uses30d).toBe(0);
    expect(t.lastUsedDay).toBeNull();
  });
});

// A15: the skill-eval templates/06 fixture. Applying it must answer `leftOut`, and it must
// stay off the index so the Public tab's three-card catalog (e2e) is unchanged.
describe("the unlisted Launch title seed", () => {
  it("is not in the index, but is live by id and installs through the real install", async () => {
    const idx = await fetchIndex({ etag: null });
    expect(idx.ok && !idx.notModified && idx.index.entries.map((e) => e.id)).not.toContain(FIXTURE_LEFT_OUT_CLOUD_ID);
    expect((await getCloudTemplate(FIXTURE_LEFT_OUT_CLOUD_ID)).ok).toBe(true);
    const r = await installTemplate(FIXTURE_LEFT_OUT_CLOUD_ID);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(getTemplate(r.templateId)).toMatchObject({ origin: "installed", cloudId: FIXTURE_LEFT_OUT_CLOUD_ID, name: FIXTURE_LEFT_OUT_NAME });
    // What an apply does to the installed layer: both author values go, named neutrally.
    const scaffold = JSON.parse(fs.readFileSync(await readTemplateFile(r.templateId, "template.json"), "utf8"));
    const layer = { ...scaffold.overlays[0], id: "text-head0001" };
    const ctx = newNeutraliseContext();
    neutraliseOverlay(layer, ctx, 1);
    expect(leftOutList(ctx)).toEqual(["layer 1 (text-head0001): outline not recognised", "layer 1 (text-head0001): exit effect not available"]);
    const said = leftOutList(ctx).join("\n");
    for (const v of Object.values(FIXTURE_LEFT_OUT_AUTHOR_VALUES)) expect(said).not.toContain(v);
  });

  // I3 on A15: the agent may say the template's name freely, so a word shared with the
  // author values ("Glow title" beside `author-neon-glow`) blinds 06's paraphrase check.
  it("has a name and tags that share no word with its author values", () => {
    const valueStems = authorTermStems(Object.values(FIXTURE_LEFT_OUT_AUTHOR_VALUES));
    const shown = [FIXTURE_LEFT_OUT_NAME, ...FIXTURE_LEFT_OUT_TAGS].join(" ").toLowerCase();
    expect(valueStems.length).toBeGreaterThan(0);
    for (const stem of valueStems) expect(shown).not.toContain(stem);
  });
});

// QA fix round 1 (A13 live walk). The first seeds' poster was a 1x1 white JPEG,
// so every Public card showed a blank white box; and their text layer's rect was
// normalised (0.8 wide) in a composition that is in PIXELS, so an applied seed
// wrapped one word per line around x = 0.5 px, clipped at the preview's left edge.
describe("the seeds look like what they are", () => {
  /** A baseline or progressive JPEG's frame size, from its SOF marker. */
  function jpegSize(b: Buffer): { width: number; height: number } {
    expect([...b.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) throw new Error(`not a JPEG marker at ${i}`);
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    throw new Error("no SOF marker");
  }
  const seeds = () => [...getFixtureCatalog().entries.values()].filter((e) => (FIXTURE_CLOUD_IDS as readonly string[]).includes(e.id));

  it("each seed's poster is a real frame with its example's shape, not a 1x1 stand-in", async () => {
    for (const e of seeds()) {
      const poster = await api("GET", `bucket/${e.example.poster}`);
      expect(poster.status, e.name).toBe(200);
      const { width, height } = jpegSize(poster.body);
      expect(Math.min(width, height), e.name).toBeGreaterThanOrEqual(64);
      expect(width / height, e.name).toBeCloseTo(e.example.width / e.example.height, 1);
    }
  });

  it.skipIf(!hasFfmpeg())("each seed's poster shows its clip's own colour (the first frame; the vertical clip's at 1 s)", async () => {
    for (const e of seeds()) {
      const dir = fs.mkdtempSync(path.join(home, "poster-"));
      const posterPath = path.join(dir, "poster.jpg");
      const clipPath = path.join(dir, "example.mp4");
      fs.writeFileSync(posterPath, (await api("GET", `bucket/${e.example.poster}`)).body);
      fs.writeFileSync(clipPath, (await api("GET", `bucket/${e.example.video}`)).body);
      const p = await extractFrameRgba(posterPath, 0);
      const c = await extractFrameRgba(clipPath, 1);
      const pm = sampleRegionMean(p, { x: 0, y: 0, w: p.width, h: p.height });
      const cm = sampleRegionMean(c, { x: 0, y: 0, w: c.width, h: c.height });
      for (let k = 0; k < 3; k++) expect(Math.abs(pm[k] - cm[k]), `${e.name} channel ${k}`).toBeLessThan(16);
      // Never the blank white the first seeds showed.
      expect(Math.min(pm[0], pm[1], pm[2]), e.name).toBeLessThan(200);
    }
  });

  it("each seed's text layer is in its canvas's pixel space and fits inside it", async () => {
    for (const e of seeds()) {
      const scaffold = JSON.parse((await api("GET", `bucket/templates/${e.id}/v1/template.json`)).body.toString());
      const { width: W, height: H } = scaffold.canvas;
      for (const o of scaffold.overlays) {
        const r = o.rect;
        expect(r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H, `${e.name} ${JSON.stringify(r)} in ${W}x${H}`).toBe(true);
        // A headline gets most of the frame's width, and room for a line of its font.
        expect(r.width, e.name).toBeGreaterThanOrEqual(W / 2);
        expect(r.height, e.name).toBeGreaterThanOrEqual(Number(/(\d+)px/.exec(o.font)?.[1] ?? 0));
      }
    }
  });
});

// --- publish ------------------------------------------------------------------

describe("publish", () => {
  it("a full round trip through the real client lands a fourth entry, and is recorded", async () => {
    expect(await setNickname(KEY, "eval-bot")).toEqual({ ok: true, nickname: "eval-bot" });
    const { prep, commit } = await publish();
    expect(prep.ok && prep.version).toBe(1);
    // Staged under tmp/<id>/v1/, as the site signs them; the client refuses anything else.
    expect(prep.ok && prep.uploads.every((u) => u.url.includes(`/bucket/tmp/${prep.templateId}/v1/`))).toBe(true);
    expect(commit).toEqual({ ok: true, templateId: prep.ok && prep.templateId, version: 1, indexed: true });
    const idx = await fetchIndex({ etag: null });
    expect(idx.ok && !idx.notModified && idx.index.entries.map((e) => [e.name, e.nickname])).toContainEqual(["Hook + caption", "eval-bot"]);
    const mine = await fetchMine(KEY);
    expect(mine.ok && mine.templates.map((t) => [t.version, t.hidden, t.moderated, t.indexPending])).toEqual([[1, false, false, false]]);
    expect(trace().map((t) => t.tool)).toEqual(expect.arrayContaining(["authors_me", "prepare", "commit", "index", "mine"]));
  });

  it("answers the schemaHash handshake first — whatever else is wrong with the body", async () => {
    const r = await api("POST", "publish/prepare", { schemaHash: "0".repeat(64), name: 7 }, bearer());
    expect([r.status, jsonOf(r).code]).toEqual([409, "schema_unsupported"]);
    const ok = await api("POST", "publish/prepare", { schemaHash: SCAFFOLD_SCHEMA_SHA256, name: 7 }, bearer());
    expect([ok.status, jsonOf(ok).code]).toEqual([400, "invalid"]);
  });

  it("replays a commit that succeeded with the same success; a different body is replay_mismatch", async () => {
    await setNickname(KEY, "eval-bot");
    const { commitBody, commit } = await publish();
    expect(await publishCommit(KEY, commitBody)).toEqual(commit);
    const changed = { ...commitBody, description: "Something else", scaffold: { ...commitBody.scaffold, description: "Something else" } };
    expect(await publishCommit(KEY, changed)).toMatchObject({ ok: false, status: 409, code: "replay_mismatch" });
    // Still one template, one publish.
    expect(getFixtureCatalog().authors.values().next().value).toMatchObject({ templateCount: 1, publishes: { count: 1 } });
  });

  it("indexed: false — live but not listed — until a replay lists it", async () => {
    await setNickname(KEY, "eval-bot");
    injectFixtureFault({ route: "commit", code: "unindexed" });
    const { prep, commitBody, commit } = await publish();
    expect(commit).toMatchObject({ ok: true, indexed: false });
    const mine = await fetchMine(KEY);
    expect(mine.ok && mine.templates[0].indexPending).toBe(true);
    const idx = await fetchIndex({ etag: null });
    expect(idx.ok && !idx.notModified && idx.index.entries.some((e) => prep.ok && e.id === prep.templateId)).toBe(false);
    expect(await publishCommit(KEY, commitBody)).toMatchObject({ ok: true, indexed: true });
  });

  it("keeps a first publish's id reserved for its author: prepare again reuses it; a stranger is forbidden; an unknown id is not_found", async () => {
    await setNickname(KEY, "eval-bot");
    await setNickname(OTHER_KEY, "someone");
    const { body } = publishBody();
    const first = await publishPrepare(KEY, body);
    if (!first.ok) throw new Error(first.error);
    expect(await publishPrepare(KEY, { ...body, templateId: first.templateId })).toMatchObject({ ok: true, templateId: first.templateId, version: 1 });
    expect(await publishPrepare(OTHER_KEY, { ...body, templateId: first.templateId })).toMatchObject({ ok: false, status: 403, code: "forbidden" });
    expect(await publishPrepare(KEY, { ...body, templateId: "zzzzzzzzzzzzzzzzzzzz" })).toMatchObject({ ok: false, status: 404, code: "not_found" });
  });

  it("a republish is v2, retires v1's files, and keeps the template's uses", async () => {
    await setNickname(KEY, "eval-bot");
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    await reportUse(id);
    const second = await publish(KEY, {}, id);
    expect(second.commit).toMatchObject({ ok: true, templateId: id, version: 2, indexed: true });
    const f = getFixtureCatalog();
    expect(f.objects.has(`templates/${id}/v2/template.json`)).toBe(true);
    expect(f.objects.has(`templates/${id}/v1/template.json`)).toBe(false);
    expect(f.objects.has(`retired/${id}/v1/template.json`)).toBe(true);
    expect(f.entries.get(id)?.uses.total).toBe(1);
  });

  it("holds uploads to what was signed: path, type and size", async () => {
    await setNickname(KEY, "eval-bot");
    const { body } = publishBody();
    const prep = await publishPrepare(KEY, body);
    if (!prep.ok) throw new Error(prep.error);
    const up = prep.uploads.find((u) => u.name === "poster.jpg")!;
    const rel = up.url.slice(up.url.indexOf("bucket/"));
    expect((await api("PUT", rel, JPG, { ...up.headers, "Content-Type": "image/png" })).status).toBe(403);
    expect((await api("PUT", rel.replace("poster.jpg", "extra.jpg"), JPG, up.headers)).status).toBe(403);
    expect((await api("PUT", rel, Buffer.concat([JPG, JPG]), up.headers)).status).toBe(400);
    expect((await api("PUT", rel, JPG, up.headers)).status).toBe(200);
  });

  it("refuses at commit a staged file that is not what prepare validated", async () => {
    await setNickname(KEY, "eval-bot");
    const { body, bytes } = publishBody();
    const prep = await publishPrepare(KEY, body);
    if (!prep.ok) throw new Error(prep.error);
    for (const up of prep.uploads) await uploadSigned(up, up.name === "index.md" ? Buffer.from("# Purpose\nA hoax.\n") : bytes.get(up.name)!);
    const r = await publishCommit(KEY, { ...body, templateId: prep.templateId, version: prep.version });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid" });
    // The refusal settled the attempt: nothing pending, nothing staged.
    expect(await publishCommit(KEY, { ...body, templateId: prep.templateId, version: prep.version })).toMatchObject({ code: "nothing_pending" });
    expect([...getFixtureCatalog().objects.keys()].some((k) => k.startsWith("tmp/"))).toBe(false);
  });
});

// --- use, report, visibility ----------------------------------------------------------

describe("use, report and the owner's visibility", () => {
  it("a use counts once per client per UTC day; a repeat is answered alike", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    const before = getFixtureCatalog().entries.get(id)!.uses.total;
    expect(await reportUse(id)).toEqual({ ok: true });
    expect(await reportUse(id)).toEqual({ ok: true });
    expect(getFixtureCatalog().entries.get(id)!.uses.total).toBe(before + 1);
    await api("POST", `${id}/use`, {}, { "x-libi-fixture-client": "someone-else" });
    expect(getFixtureCatalog().entries.get(id)!.uses.total).toBe(before + 2);
    expect(trace().filter((t) => t.tool === "use")).toHaveLength(3);
  });

  it("five distinct reporters hide a template for moderation: gone from the index, GET and use 404, its owner can't show it again", async () => {
    await setNickname(KEY, "eval-bot");
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    // One client reporting five times is one report.
    for (let i = 0; i < 5; i++) expect(await reportTemplate(id, "spam")).toEqual({ ok: true, hidden: false });
    for (let i = 1; i < 5; i++) await api("POST", `${id}/report`, { reason: "spam" }, { "x-libi-fixture-client": `c${i}` });
    expect(await reportTemplate(id, "broken")).toEqual({ ok: true, hidden: true });
    const idx = await fetchIndex({ etag: null });
    expect(idx.ok && !idx.notModified && idx.index.entries.map((e) => e.id)).not.toContain(id);
    expect(await getCloudTemplate(id)).toMatchObject({ ok: false, status: 404, code: "not_found" });
    expect(await reportUse(id)).toMatchObject({ ok: false, status: 404, code: "not_found" });
    const mine = await fetchMine(KEY);
    // Its statement of reasons, as the site writes one on an automatic hide: hidden after reports, pending review.
    expect(mine.ok && mine.templates[0]).toMatchObject({ hidden: true, moderated: true, moderation: { reason: "reports", note: null } });
    expect(await setTemplateHidden(KEY, id, false)).toMatchObject({ ok: false, status: 403, code: "moderated" });
    const again = await publishPrepare(KEY, { ...publishBody().body, templateId: id });
    expect(again).toMatchObject({ ok: false, status: 403, code: "moderated" });
  });

  it("a rename is refused 403 creator_not_approved for an unapproved author who owns a template — hidden or not; approved, it goes through", async () => {
    await setNickname(KEY, "eval-bot");
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    const f = getFixtureCatalog();
    const authorId = [...f.entries.values()].find((d) => d.id === id)!.authorId;
    f.creators.set(authorId, "rejected"); // approval withdrawn
    expect(await setNickname(KEY, "new name")).toMatchObject({ ok: false, status: 403, code: "creator_not_approved" });
    expect(f.authors.get(authorId)!.nickname).toBe("eval-bot");
    // A hide is never gated — and doesn't free the rename: the nickname is on the hidden template too.
    expect(await setTemplateHidden(KEY, id, true)).toMatchObject({ ok: true });
    expect(await setNickname(KEY, "new name")).toMatchObject({ ok: false, status: 403, code: "creator_not_approved" });
    expect(f.authors.get(authorId)!.nickname).toBe("eval-bot");
    f.creators.set(authorId, "approved");
    expect(await setNickname(KEY, "new name")).toMatchObject({ ok: true, nickname: "new name" });
  });

  it("a report's details are stored with it and traced only as hasDetails — never the text", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    expect(await reportTemplate(id, "copyright", "my secret-clip, filmed 2024")).toEqual({ ok: true, hidden: false });
    await api("POST", `${id}/report`, { reason: "spam" }, { "x-libi-fixture-client": "c2" });
    const stored = getFixtureCatalog().reports.filter((r) => r.id === id);
    expect(stored.map((r) => r.details)).toEqual(["my secret-clip, filmed 2024", ""]);
    const lines = trace().filter((t) => t.tool === "report");
    expect(lines.map((l) => l.input)).toEqual([
      { id, reason: "copyright", hasDetails: true },
      { id, reason: "spam", hasDetails: false },
    ]);
    expect(fs.readFileSync(path.join(home, "test-mode", FIXTURE_TRACE_FILE), "utf8")).not.toContain("secret-clip");
  });

  it("refuses details the site refuses (not text, over 2000, control/bidi) as 400 invalid, counting nothing", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    for (const details of [5, "x".repeat(2001), "a\u202Eb"]) {
      const r = await api("POST", `${id}/report`, { reason: "other", details });
      expect(r.status, String(details).slice(0, 10)).toBe(400);
      expect(jsonOf(r)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(getFixtureCatalog().reports).toHaveLength(0);
  });

  it("/mine carries the operator's statement of reasons for a moderated template only; everything else lists moderation: null", async () => {
    await setNickname(KEY, "eval-bot");
    const a = (await publish()).prep;
    const b = (await publish(KEY, { name: "Second one" })).prep;
    const [idA, idB] = [a.ok ? a.templateId : "", b.ok ? b.templateId : ""];
    for (let i = 0; i < 5; i++) await api("POST", `${idA}/report`, { reason: "copyright" }, { "x-libi-fixture-client": `c${i}` });
    const f = getFixtureCatalog();
    // Set by an operator in the console — on both, but only the moderated one is taken down.
    const at = Date.UTC(2026, 8, 30, 10);
    f.entries.get(idA)!.moderation = { reason: "copyright", note: "DMCA notice", at };
    f.entries.get(idB)!.moderation = { reason: "terms", note: null, at };
    const mine = await fetchMine(KEY);
    const byId = new Map((mine.ok ? mine.templates : []).map((t) => [t.id, t]));
    expect(byId.get(idA)).toMatchObject({ moderated: true, moderation: { reason: "copyright", note: "DMCA notice", at: new Date(at).toISOString() } });
    expect(byId.get(idB)!.moderation).toBeNull();
    // The owner hiding it themselves is not moderation either.
    expect(await setTemplateHidden(KEY, idB, true)).toMatchObject({ ok: true, template: { hidden: true, moderated: false, moderation: null } });
  });

  it("a report of an id with no template answers like a hidden one", async () => {
    expect(await reportTemplate("zzzzzzzzzzzzzzzzzzzz", "spam")).toEqual({ ok: true, hidden: true });
  });

  it("the owner hides and shows again; files deleted meanwhile make it gone", async () => {
    await setNickname(KEY, "eval-bot");
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    expect(await setTemplateHidden(KEY, id, true)).toMatchObject({ ok: true, template: { hidden: true, moderated: false } });
    expect(await getCloudTemplate(id)).toMatchObject({ code: "not_found" });
    expect(await setTemplateHidden(OTHER_KEY, id, false)).toMatchObject({ ok: false, status: 404, code: "not_found" });
    expect(await setTemplateHidden(KEY, id, false)).toMatchObject({ ok: true, template: { hidden: false } });
    expect(await getCloudTemplate(id)).toMatchObject({ ok: true });
    await setTemplateHidden(KEY, id, true);
    const f = getFixtureCatalog();
    for (const k of [...f.objects.keys()]) if (k.startsWith(`retired/${id}/`)) f.objects.delete(k);
    expect(await setTemplateHidden(KEY, id, false)).toMatchObject({ ok: false, status: 410, code: "gone" });
  });
});

// --- creator approval (invite-only publishing) ---------------------------------------

describe("creator approval", () => {
  const AUTHOR_ID = createHash("sha256").update(KEY).digest("base64url");
  const SITE_NOT_APPROVED = "Publishing to the catalog is invite-only, and this creator key isn't approved yet. Apply from libi's Templates page.";
  const SITE_CLOSED = "This application was already decided. Email admin@nagellabs.com if you think that's a mistake.";
  const prepareBody = () => ({ ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 });

  it("every author is approved by default: the status reads approved and a publish goes through", async () => {
    const r = await api("GET", "creators/me", undefined, bearer());
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toEqual({ ok: true, status: "approved" });
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    expect((await publish()).commit.ok).toBe(true);
    // Through the real client too.
    expect(await creatorStatus(KEY)).toEqual({ ok: true, status: "approved" });
    expect(await applyAsCreator(KEY, { email: "a@b.co", note: "", appVersion: null })).toEqual({ ok: true, status: "approved" });
    expect(getFixtureCatalog().creators.has(AUTHOR_ID)).toBe(false);
  });

  it("LIBI_TEST_CATALOG_CREATOR=none: prepare and commit refuse 403 creator_not_approved with the site's words; applying makes it pending", async () => {
    vi.stubEnv("LIBI_TEST_CATALOG_CREATOR", "none");
    __resetFixtureCatalogForTests();
    expect(jsonOf(await api("GET", "creators/me", undefined, bearer()))).toEqual({ ok: true, status: "none" });
    // Checked before the nickname: an unapproved author without one hears the real blocker.
    const noNick = await api("POST", "publish/prepare", prepareBody(), bearer());
    expect(noNick.status).toBe(403);
    expect(jsonOf(noNick)).toEqual({ ok: false, code: "creator_not_approved", error: SITE_NOT_APPROVED });
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    const prep = await api("POST", "publish/prepare", prepareBody(), bearer());
    expect(prep.status).toBe(403);
    expect(jsonOf(prep)).toEqual({ ok: false, code: "creator_not_approved", error: SITE_NOT_APPROVED });
    expect(getFixtureCatalog().pending.size).toBe(0);

    const applied = await api("POST", "creators/me", { email: " A@B.co ", note: "hooks" }, bearer());
    expect(applied.status).toBe(200);
    expect(jsonOf(applied)).toEqual({ ok: true, status: "pending" });
    expect(jsonOf(await api("GET", "creators/me", undefined, bearer()))).toEqual({ ok: true, status: "pending" });

    const commit = await api("POST", "publish/commit", { ...prepareBody(), templateId: "zzzzzzzzzzzzzzzzzzzz", version: 1 }, bearer());
    expect({ status: commit.status, code: jsonOf(commit).code }).toEqual({ status: 403, code: "creator_not_approved" });
  });

  it("a commit prepared while approved is refused once the approval is gone", async () => {
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    const { body, bytes } = publishBody();
    const prep = await publishPrepare(KEY, body);
    if (!prep.ok) throw new Error(prep.error);
    for (const up of prep.uploads) await uploadSigned(up, bytes.get(up.name)!);
    getFixtureCatalog().creators.set(AUTHOR_ID, "pending");
    expect(await publishCommit(KEY, { ...body, templateId: prep.templateId, version: prep.version })).toMatchObject({ ok: false, status: 403, code: "creator_not_approved" });
    expect(getFixtureCatalog().entries.has(prep.templateId)).toBe(false);
  });

  it("a rejected author's application is closed: 409 creator_request_closed with the site's words", async () => {
    getFixtureCatalog().creators.set(AUTHOR_ID, "rejected");
    const r = await api("POST", "creators/me", { email: "a@b.co" }, bearer());
    expect(r.status).toBe(409);
    expect(jsonOf(r)).toEqual({ ok: false, code: "creator_request_closed", error: SITE_CLOSED });
    expect(getFixtureCatalog().creators.get(AUTHOR_ID)).toBe("rejected");
    expect(await applyAsCreator(KEY, { email: "a@b.co", note: "", appVersion: null })).toMatchObject({ ok: false, status: 409, code: "creator_request_closed" });
  });

  it("an application needs a key and a real email", async () => {
    expect((await api("POST", "creators/me", { email: "a@b.co" })).status).toBe(401);
    expect((await api("GET", "creators/me")).status).toBe(401);
    const bad = await api("POST", "creators/me", { email: "nope" }, bearer());
    expect({ status: bad.status, code: jsonOf(bad).code }).toEqual({ status: 400, code: "invalid" });
    expect((await api("POST", "creators/me", Buffer.from("x".repeat(5000)), { ...bearer(), "content-type": "application/json" })).status).toBe(413);
  });

  it("an unapproved owner may always hide, but not edit the listing or show it again", async () => {
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    getFixtureCatalog().creators.set(AUTHOR_ID, "pending");
    const edit = await api("PATCH", id, { name: "New name" }, bearer());
    expect({ status: edit.status, code: jsonOf(edit).code }).toEqual({ status: 403, code: "creator_not_approved" });
    expect(getFixtureCatalog().entries.get(id)!.name).not.toBe("New name");
    // A hide together with an edit writes nothing: the edit is refused first.
    expect((await api("PATCH", id, { hidden: true, tags: ["x"] }, bearer())).status).toBe(403);
    expect(getFixtureCatalog().entries.get(id)!.hidden).toBe(false);
    const hide = await api("PATCH", id, { hidden: true }, bearer());
    expect(hide.status).toBe(200);
    expect(getFixtureCatalog().entries.get(id)!.hidden).toBe(true);
    const show = await api("PATCH", id, { hidden: false }, bearer());
    expect({ status: show.status, code: jsonOf(show).code }).toEqual({ status: 403, code: "creator_not_approved" });
    expect(getFixtureCatalog().entries.get(id)!.hidden).toBe(true);
  });

  it("an unhide of a moderated template still answers moderated first", async () => {
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    const { prep } = await publish();
    const id = prep.ok ? prep.templateId : "";
    for (let i = 0; i < 5; i++) await api("POST", `${id}/report`, { reason: "spam" }, { "x-libi-fixture-client": `c${i}` });
    vi.stubEnv("LIBI_TEST_CATALOG_CREATOR", "none");
    expect(jsonOf(await api("PATCH", id, { hidden: false }, bearer())).code).toBe("moderated");
  });

  it("traces creators_me by method only — never the email", async () => {
    await api("GET", "creators/me", undefined, bearer());
    await api("POST", "creators/me", { email: "secret-person@example.com", note: "hooks" }, bearer());
    const lines = trace().filter((l) => l.tool === "creators_me");
    expect(lines.map((l) => l.input)).toEqual([{ method: "GET" }, { method: "POST" }]);
    expect(fs.readFileSync(path.join(home, "test-mode", FIXTURE_TRACE_FILE), "utf8")).not.toContain("secret-person");
  });

  it("sends each new code under the site's status", () => {
    expect(FIXTURE_CODE_STATUS.creator_not_approved).toBe(403);
    expect(FIXTURE_CODE_STATUS.creator_request_closed).toBe(409);
  });
});

// --- parity with the site's codes -----------------------------------------------------

/**
 * libi-site lib/templates/publish.ts#PUBLISH_ERROR_CODES, copied verbatim and
 * pinned by the hash of that source text — as the scaffold schema is pinned.
 * A site change breaks the pin where the site checkout is at hand
 * (LIBI_SITE_DIR); re-copy the block, re-pin, and teach the fixture the new code.
 */
const SITE_CODES_SOURCE = `export const PUBLISH_ERROR_CODES = [
  "busy",
  "nothing_pending",
  "wrong_version",
  "replay_mismatch",
  "upload_changed",
  "body_mismatch",
  "expired",
  "not_found",
  "forbidden",
  "moderated",
  "gone",
  "nickname_required",
  "creator_not_approved",
  "creator_request_closed",
  "schema_unsupported",
  "code_templates_disabled",
  "publishing_paused",
  "caps_daily",
  "caps_total",
  "caps_global",
  "unauthorized",
  "rate_limited",
  "contended",
  "invalid",
  "internal",
] as const;`;
const SITE_CODES_SHA256 = "7644009ea0123213967aa218c7962caf98c5d296159f8c0bbdda7c9f7fd5c66e";
const SITE_CODES = [...SITE_CODES_SOURCE.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
const SITE_DIR = process.env.LIBI_SITE_DIR;

/**
 * libi-site lib/templates/constants.ts#MODERATION_REASONS, copied verbatim and
 * pinned like the codes above: a reason libi doesn't list reads as "other", so
 * a site that adds one ("reports", an automatic hide after reports) must be
 * mirrored in lib/templates/cloud/constants.ts with its label.
 */
const SITE_MODERATION_SOURCE = `export const MODERATION_REASONS = ["copyright", "rights", "illegal", "terms", "other", "reports"] as const;`;
const SITE_MODERATION_SHA256 = "1cdce241c1fccaafe5b077b9c05d4180d021a5542204a2aafe0a5ad258ae5cb7";

describe("parity with libi-site's moderation reasons", () => {
  it("the copy is the pinned source text, and libi lists exactly those reasons, in order, each with a label", () => {
    expect(createHash("sha256").update(SITE_MODERATION_SOURCE).digest("hex")).toBe(SITE_MODERATION_SHA256);
    const site = [...SITE_MODERATION_SOURCE.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...MODERATION_REASONS]).toEqual(site);
    expect(Object.keys(MODERATION_REASON_LABELS).sort()).toEqual([...site].sort());
  });

  it.skipIf(!SITE_DIR)("the pin matches the site checkout at LIBI_SITE_DIR", () => {
    const src = fs.readFileSync(path.join(SITE_DIR!, "lib/templates/constants.ts"), "utf8");
    const block = /export const MODERATION_REASONS = \[[\s\S]*?\] as const;/.exec(src)?.[0] ?? "";
    expect(createHash("sha256").update(block).digest("hex")).toBe(SITE_MODERATION_SHA256);
  });
});

describe("the rename refusal says what the site's Terms §4A say", () => {
  const TERMS_CLAUSE = "only an approved creator can change it, even while your templates are hidden";
  it("libi's message carries the Terms' own clause (and never says 'in the catalog', which a hidden template is not)", () => {
    expect(CREATOR_NOT_APPROVED_RENAME_MESSAGE).toContain(TERMS_CLAUSE);
    expect(CREATOR_NOT_APPROVED_RENAME_MESSAGE).not.toMatch(/in the catalog/);
  });
  it.skipIf(!SITE_DIR)("the clause is in the site's Terms at LIBI_SITE_DIR", () => {
    const terms = fs.readFileSync(path.join(SITE_DIR!, "lib/legal-content.ts"), "utf8").replace(/\s+/g, " ");
    expect(terms).toContain(TERMS_CLAUSE);
  });
});

describe("parity with libi-site's refusal codes", () => {
  it("the copy is the pinned source text", () => {
    expect(createHash("sha256").update(SITE_CODES_SOURCE).digest("hex")).toBe(SITE_CODES_SHA256);
  });

  it.skipIf(!SITE_DIR)("the pin matches the site checkout at LIBI_SITE_DIR", () => {
    const src = fs.readFileSync(path.join(SITE_DIR!, "lib/templates/publish.ts"), "utf8");
    const block = /export const PUBLISH_ERROR_CODES = \[[\s\S]*?\] as const;/.exec(src)?.[0] ?? "";
    expect(createHash("sha256").update(block).digest("hex")).toBe(SITE_CODES_SHA256);
  });

  it("the client handles exactly the site's codes, and the fixture knows a status for each", () => {
    expect([...PUBLISH_ERROR_CODES].sort()).toEqual([...SITE_CODES].sort());
    expect(Object.keys(FIXTURE_CODE_STATUS).sort()).toEqual([...SITE_CODES].sort());
  });

  /** Drives the fixture into `code` — by its natural path where one exists, by a fault only where the site's clock or concurrency decides. */
  async function produce(code: PublishErrorCode): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const f = getFixtureCatalog();
    const [seedId] = FIXTURE_CLOUD_IDS;
    const withNick = async () => api("PUT", "authors/me", { nickname: "eval-bot" }, bearer());
    const prepared = async () => {
      await withNick();
      const { body, bytes } = publishBody();
      const r = jsonOf(await api("POST", "publish/prepare", { ...body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer())) as { templateId: string; version: number; uploads: Array<{ name: string; url: string; headers: Record<string, string> }> };
      for (const up of r.uploads) await api("PUT", up.url.slice(up.url.indexOf("bucket/")), bytes.get(up.name)!, up.headers);
      return { body: { ...body, schemaHash: SCAFFOLD_SCHEMA_SHA256, templateId: r.templateId, version: r.version }, id: r.templateId };
    };
    const commit = (b: unknown, key = KEY) => api("POST", "publish/commit", b, bearer(key));
    switch (code) {
      case "busy": {
        const { body, id } = await prepared();
        f.pending.get(`${id}/v1`)!.claimedUntil = Date.now() + 60_000; // another commit holds it
        return commit(body);
      }
      case "nothing_pending": {
        const { body } = await prepared();
        return commit({ ...body, templateId: "zzzzzzzzzzzzzzzzzzzz" });
      }
      case "wrong_version": {
        const { body, id } = await prepared();
        // v1 landed from elsewhere while this commit waited.
        const seed = f.entries.get(seedId)!;
        f.entries.set(id, { ...seed, id, authorId: createHash("sha256").update(KEY).digest("base64url"), version: 1 });
        return commit(body);
      }
      case "replay_mismatch": {
        const { body } = await prepared();
        await commit(body);
        return commit({ ...body, instructions: "# Purpose\nOther.\n" });
      }
      case "upload_changed": {
        const { body } = await prepared();
        injectFixtureFault({ route: "commit", code: "upload_changed" });
        return commit(body);
      }
      case "body_mismatch": {
        const { body } = await prepared();
        return commit({ ...body, instructions: "# Purpose\nOther.\n" });
      }
      case "expired": {
        const { body, id } = await prepared();
        f.pending.get(`${id}/v1`)!.expiresAt = Date.now() - 1;
        return commit(body);
      }
      case "not_found":
        return api("GET", "zzzzzzzzzzzzzzzzzzzz");
      case "forbidden": {
        const { body } = await prepared();
        await commit(body);
        await api("PUT", "authors/me", { nickname: "someone" }, bearer(OTHER_KEY));
        return api("POST", "publish/prepare", { ...body, version: undefined }, bearer(OTHER_KEY));
      }
      case "moderated": {
        const { body, id } = await prepared();
        await commit(body);
        for (let i = 0; i < 5; i++) await api("POST", `${id}/report`, { reason: "spam" }, { "x-libi-fixture-client": `c${i}` });
        return api("PATCH", id, { hidden: false }, bearer());
      }
      case "gone": {
        const { body, id } = await prepared();
        await commit(body);
        await api("PATCH", id, { hidden: true }, bearer());
        for (const k of [...f.objects.keys()]) if (k.startsWith(`retired/${id}/`)) f.objects.delete(k);
        return api("PATCH", id, { hidden: false }, bearer());
      }
      case "nickname_required":
        return api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      case "creator_not_approved":
        await withNick();
        f.creators.set(createHash("sha256").update(KEY).digest("base64url"), "pending");
        return api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      case "creator_request_closed":
        f.creators.set(createHash("sha256").update(KEY).digest("base64url"), "rejected");
        return api("POST", "creators/me", { email: "a@b.co" }, bearer());
      case "schema_unsupported":
        return api("POST", "publish/prepare", { ...publishBody().body }, bearer());
      case "code_templates_disabled": {
        await withNick();
        const { body } = publishBody();
        const fx = { key: "fx", kind: "code", displayName: "FX", rect: { x: 0, y: 0, width: 1, height: 1 }, startTime: 0, duration: 3, z: 2, opacity: 1, codeFile: "overlays/fx/draw.jsx" };
        const scaffold = { ...body.scaffold, overlays: [...body.scaffold.overlays, fx] };
        return api("POST", "publish/prepare", { ...body, scaffold, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      }
      case "caps_daily": {
        await withNick();
        const authorId = createHash("sha256").update(KEY).digest("base64url");
        f.authors.get(authorId)!.publishes = { day: new Date().toISOString().slice(0, 10).replace(/-/g, ""), count: 20 };
        return api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      }
      case "caps_total": {
        await withNick();
        f.authors.get(createHash("sha256").update(KEY).digest("base64url"))!.templateCount = 200;
        return api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      }
      // The operator's kill switch and the catalog-wide daily cap: the site's environment and counters decide both.
      case "publishing_paused": {
        const { body } = await prepared();
        injectFixtureFault({ route: "commit", code: "publishing_paused" });
        return commit(body);
      }
      case "caps_global":
        await withNick();
        injectFixtureFault({ route: "prepare", code: "caps_global" });
        return api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer());
      case "unauthorized":
        return api("GET", "mine");
      case "invalid":
        return api("POST", `${seedId}/report`, { reason: "boring" });
      case "rate_limited":
        injectFixtureFault({ route: "index", code: "rate_limited" });
        return api("GET", "index");
      case "contended":
        injectFixtureFault({ route: "use", code: "contended" });
        return api("POST", `${seedId}/use`, {});
      case "internal":
        injectFixtureFault({ route: "prepare", code: "internal" });
        return api("POST", "publish/prepare", {}, bearer());
    }
  }

  it.each(SITE_CODES)("produces %s, under the site's status and with its code", async (code) => {
    const r = await produce(code as PublishErrorCode);
    expect({ status: r.status, code: jsonOf(r).code, ok: jsonOf(r).ok }).toEqual({ status: FIXTURE_CODE_STATUS[code as PublishErrorCode], code, ok: false });
    if (code === "rate_limited") expect(r.headers["Retry-After"]).toBe("60");
    if (code === "contended") expect(r.headers["Retry-After"]).toBe("5");
  });

  it("publishing_paused and caps_global carry the site's words; the global cap names prepares at prepare and new templates at commit", async () => {
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    injectFixtureFault({ route: "prepare", code: "publishing_paused" });
    expect(jsonOf(await api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer()))).toMatchObject({
      code: "publishing_paused",
      error: "Publishing to the catalog is paused right now. Nothing was published — try again later.",
    });
    injectFixtureFault({ route: "prepare", code: "caps_global" });
    expect(jsonOf(await api("POST", "publish/prepare", { ...publishBody().body, schemaHash: SCAFFOLD_SCHEMA_SHA256 }, bearer()))).toMatchObject({
      code: "caps_global",
      error: "The catalog has taken all the publishes it can today. Try again tomorrow (UTC).",
    });
    const first = await publish();
    injectFixtureFault({ route: "commit", code: "caps_global" });
    const r = await api("POST", "publish/commit", first.commitBody, bearer());
    expect({ status: r.status, ...jsonOf(r) }).toMatchObject({ status: 429, code: "caps_global", error: "The catalog has taken all the new templates it can today. Try again tomorrow (UTC)." });
  });

  // A13 review Minor 9: an injected wrong_version names the version the fixture would expect, not always 1.
  it("an injected wrong_version names the version this template is at + 1", async () => {
    await api("PUT", "authors/me", { nickname: "nadav" }, bearer());
    const first = await publish();
    expect(first.commit.ok).toBe(true);
    injectFixtureFault({ route: "commit", code: "wrong_version" });
    const r = await api("POST", "publish/commit", { ...first.commitBody, version: 2 }, bearer());
    expect(jsonOf(r)).toMatchObject({ code: "wrong_version", error: "Expected version 2; run prepare again." });
  });

  // A13 review Minor 5: a fixture bug answers 500 internal like the site, and says what broke in the log.
  it("a fixture bug answers 500 internal and logs the error", async () => {
    const error = vi.spyOn(serverLogger, "error").mockImplementation(() => undefined);
    const f = getFixtureCatalog();
    const real = f.entries;
    f.entries = { values: () => { throw new Error("fixture bug"); } } as unknown as typeof f.entries;
    try {
      const r = await api("GET", "index");
      expect({ status: r.status, code: jsonOf(r).code }).toEqual({ status: 500, code: "internal" });
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ tag: "templates", op: "fixture_internal", route: "index", err: expect.any(Error) }), expect.any(String));
    } finally {
      f.entries = real;
      error.mockRestore();
    }
  });

  it("POST _faults takes only a known route and code", async () => {
    expect((await api("POST", "_faults", { route: "use", code: "contended" })).status).toBe(200);
    for (const bad of [{ route: "nope", code: "internal" }, { route: "use", code: "nope" }, { route: "use", code: "internal", times: 0 }, [1]]) {
      expect((await api("POST", "_faults", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api("POST", "_faults", { clear: true })).status).toBe(200);
    expect(getFixtureCatalog().faults).toEqual([]);
  });

  it("the real client reads each refusal back as the site's code with its Retry-After", async () => {
    injectFixtureFault({ route: "use", code: "contended" });
    expect(await reportUse(FIXTURE_CLOUD_IDS[0])).toMatchObject({ ok: false, status: 503, code: "contended", retryAfterMs: 5000 });
    injectFixtureFault({ route: "report", code: "rate_limited" });
    expect(await reportTemplate(FIXTURE_CLOUD_IDS[0], "spam")).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterMs: 60_000 });
  });
});

/**
 * Minor-2 (TPL review): libi-site lib/templates/shape.ts#shapePublicTemplate,
 * copied verbatim and pinned by the hash of that source text — as the codes
 * and moderation reasons above are. A site-side field rename, add or removal
 * would otherwise go undetected: TPL-1 added uses30d/lastUsedDay to the
 * fixture by hand-comparison against the site only.
 */
const SITE_SHAPE_SOURCE = `export function shapePublicTemplate(doc: TemplateDoc, base: string, now: number): PublicTemplate {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    tags: [...doc.tags],
    nickname: doc.nickname,
    authorId: doc.authorId,
    version: doc.version,
    hasCode: doc.hasCode,
    canvas: { width: doc.canvas.width, height: doc.canvas.height, fps: doc.canvas.fps },
    duration: doc.duration,
    slotCount: doc.slotCount,
    files: doc.files.map((f) => ({ ...f })),
    prefix: templatePrefix(doc.id, doc.version),
    base,
    poster: doc.example.poster,
    video: doc.example.video,
    example: { durationSec: doc.example.durationSec, width: doc.example.width, height: doc.example.height },
    usesTotal: doc.uses.total,
    uses7d: uses7d(doc.uses.byDay, now),
    uses30d: usesInDays(doc.uses.byDay, now, 30),
    lastUsedDay: doc.lastUsedAt === null ? null : new Date(doc.lastUsedAt).toISOString().slice(0, 10),
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}`;
const SITE_SHAPE_SHA256 = "4bacd14058f68dc88a2577c19c6e3be824875176f34301d79777acdf10d0f48b";
/** Top-level (4-space-indented) property names, `key:` or shorthand `key,`/`key` forms alike. */
function topLevelKeys(block: string): string[] {
  return [...block.matchAll(/^ {4}([A-Za-z0-9_]+)(:|,?\s*$)/gm)].map((m) => m[1]);
}
const SITE_SHAPE_KEYS = topLevelKeys(SITE_SHAPE_SOURCE);

describe("parity with libi-site's public template shape", () => {
  it("the copy is the pinned source text", () => {
    expect(createHash("sha256").update(SITE_SHAPE_SOURCE).digest("hex")).toBe(SITE_SHAPE_SHA256);
  });

  it.skipIf(!SITE_DIR)("the pin matches the site checkout at LIBI_SITE_DIR", () => {
    const src = fs.readFileSync(path.join(SITE_DIR!, "lib/templates/shape.ts"), "utf8");
    const block = /export function shapePublicTemplate\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(createHash("sha256").update(block).digest("hex")).toBe(SITE_SHAPE_SHA256);
  });

  it("the fixture's public shape (routeGet) has exactly the site's field names", async () => {
    const [id] = FIXTURE_CLOUD_IDS;
    const t = (jsonOf(await api("GET", id)) as { template: Record<string, unknown> }).template;
    expect(Object.keys(t).sort()).toEqual([...SITE_SHAPE_KEYS].sort());
  });
});

// --- gating ---------------------------------------------------------------------------

describe("outside test mode", () => {
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

  it("the fixture serves nothing, on any path, to any method", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "0");
    for (const m of METHODS) {
      for (const p of ["index", "mine", `${FIXTURE_CLOUD_IDS[0]}`, `bucket/templates/${FIXTURE_CLOUD_IDS[0]}/v1/poster.jpg`, "_faults", "publish/prepare"]) {
        const r = await api(m, p, m === "GET" || m === "HEAD" ? undefined : {}, bearer());
        expect([m, p, r.status, r.body.byteLength]).toEqual([m, p, 404, 0]);
      }
    }
    expect(fs.existsSync(path.join(home, "test-mode", FIXTURE_TRACE_FILE))).toBe(false);
  });

  it("the route exports every method Next routes, and each answers a bare 404 without reading the body", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    const route = await import("@/app/api/test-mode/templates-catalog/[...path]/route");
    // A method left out would get Next's own answer (OPTIONS 204 + Allow, or 405), which says the route exists.
    for (const m of METHODS) expect(typeof route[m], m).toBe("function");
    for (const m of METHODS) {
      let read = false;
      const req = new Request(`http://127.0.0.1:${port}/api/test-mode/templates-catalog/index`, { method: m === "HEAD" ? "GET" : m });
      Object.defineProperty(req, "method", { value: m });
      Object.defineProperty(req, "arrayBuffer", { value: async () => ((read = true), new ArrayBuffer(0)) });
      const res = await route[m](req, { params: Promise.resolve({ path: ["index"] }) });
      expect([m, res.status, await res.text(), read]).toEqual([m, 404, "", false]);
    }
  });

  it("nothing else points at the fixture: the client's bases are the site's and the real buckets", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "0");
    const { catalogApiBase } = await import("@/lib/templates/cloud/client");
    const { catalogBucketBaseFor } = await import("@/lib/templates/cloud/catalog-source");
    expect(catalogApiBase()).not.toContain("test-mode");
    expect(catalogBucketBaseFor()).toMatch(/^https:\/\/storage\.googleapis\.com\/libi-(prod|dev)-templates\/$/);
  });

  it("in test mode the route serves the fixture", async () => {
    const route = await import("@/app/api/test-mode/templates-catalog/[...path]/route");
    const res = await route.GET(new Request(`http://127.0.0.1:${port}${PREFIX}index`), { params: Promise.resolve({ path: ["index"] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});
