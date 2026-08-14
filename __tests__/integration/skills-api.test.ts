import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";

const VALID_BODY = `---\nname: api-test\ndescription: API test skill\n---\nBody.\n`;

type RouteContext = { params: Promise<{ id: string }> };

/** Shape of the skill objects the routes serialize (subset the tests read). */
type SkillJson = {
  id: string;
  name: string;
  enabled: boolean;
  body: string | null;
  tags: string[];
  prompts: string[];
};

/** Union of the response bodies across the skills routes. */
type SkillsApiJson = {
  skill?: SkillJson;
  skills?: SkillJson[];
  error?: string;
  success?: boolean;
};

async function callRoute(handler: (req: Request, ctx: RouteContext) => Promise<Response>, req: Request, ctx?: RouteContext): Promise<{ status: number; json: SkillsApiJson }> {
  const res = await handler(req, ctx as RouteContext);
  return { status: res.status, json: await res.json() };
}

describe("Skills REST API", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-api-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("POST /api/settings/skills creates a user skill (201) and writes file", async () => {
    const { POST } = await import("@/app/api/settings/skills/route");
    const req = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-test", description: "API test", body: VALID_BODY }),
    });
    const { status, json } = await callRoute(POST, req);
    expect(status).toBe(201);
    expect(json.skill?.name).toBe("api-test");
    const onDisk = fs.readFileSync(path.join(homeRoot, "skills/api-test/SKILL.md"), "utf-8");
    expect(onDisk).toContain("Body.");
  });

  it("POST returns 400 when frontmatter name disagrees with body.name", async () => {
    const { POST } = await import("@/app/api/settings/skills/route");
    const req = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "different", description: "x", body: VALID_BODY }),
    });
    const { status, json } = await callRoute(POST, req);
    expect(status).toBe(400);
    expect(json.error).toMatch(/name/i);
  });

  it("POST returns 409 on duplicate user skill name", async () => {
    const { POST } = await import("@/app/api/settings/skills/route");
    const req1 = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-test", description: "x", body: VALID_BODY }),
    });
    await callRoute(POST, req1);
    const req2 = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-test", description: "x", body: VALID_BODY }),
    });
    const { status } = await callRoute(POST, req2);
    expect(status).toBe(409);
  });

  it("GET /api/settings/skills lists all skills with body for user only", async () => {
    getDb().insert(skills).values([
      {
        id: "bundled-x",
        name: "bundled-x",
        description: "bundled",
        source: "bundled",
        enabled: true,
        body: null,
      },
      {
        id: "user-x",
        name: "user-x",
        description: "user",
        source: "user",
        enabled: true,
        body: VALID_BODY,
      },
    ]).run();
    const { GET } = await import("@/app/api/settings/skills/route");
    const { status, json } = await callRoute(GET, new Request("http://localhost/api/settings/skills"));
    expect(status).toBe(200);
    const bundled = json.skills?.find((s) => s.id === "bundled-x");
    const user = json.skills?.find((s) => s.id === "user-x");
    expect(bundled?.body).toBeNull();
    expect(user?.body).toBe(VALID_BODY);
  });

  it("PATCH toggles enabled", async () => {
    getDb().insert(skills).values({
      id: "to-toggle",
      name: "to-toggle",
      description: "x",
      source: "user",
      enabled: true,
      body: VALID_BODY,
    }).run();
    const { PATCH } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/to-toggle", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const { status, json } = await callRoute(PATCH, req, { params: Promise.resolve({ id: "to-toggle" }) });
    expect(status).toBe(200);
    expect(json.skill?.enabled).toBe(false);
    const row = getDb().select().from(skills).where(eq(skills.id, "to-toggle")).get();
    expect(row!.enabled).toBe(false);
  });

  it("DELETE removes a user skill (200) and removes file", async () => {
    getDb().insert(skills).values({
      id: "to-delete",
      name: "to-delete",
      description: "x",
      source: "user",
      enabled: true,
      body: VALID_BODY,
    }).run();
    const dir = path.join(homeRoot, "skills/to-delete");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), VALID_BODY);
    const { DELETE } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/to-delete", { method: "DELETE" });
    const { status, json } = await callRoute(DELETE, req, { params: Promise.resolve({ id: "to-delete" }) });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("DELETE returns 403 for bundled skills", async () => {
    getDb().insert(skills).values({
      id: "bundled-protect",
      name: "bundled-protect",
      description: "x",
      source: "bundled",
      enabled: true,
    }).run();
    const { DELETE } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/bundled-protect", { method: "DELETE" });
    const { status } = await callRoute(DELETE, req, { params: Promise.resolve({ id: "bundled-protect" }) });
    expect(status).toBe(403);
  });

  it("DELETE returns 404 for missing id", async () => {
    const { DELETE } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/nope", { method: "DELETE" });
    const { status } = await callRoute(DELETE, req, { params: Promise.resolve({ id: "nope" }) });
    expect(status).toBe(404);
  });

  it("GET returns tags and prompts per skill", async () => {
    getDb().insert(skills).values([
      {
        id: "tagged-bundled",
        name: "tagged-bundled",
        description: "bundled with tags",
        source: "bundled",
        enabled: true,
        body: null,
        tags: JSON.stringify(["video", "ai"]),
      },
      {
        id: "tagged-user",
        name: "tagged-user",
        description: "user with tags",
        source: "user",
        enabled: true,
        body: VALID_BODY,
        tags: JSON.stringify(["editing"]),
      },
    ]).run();
    const { GET } = await import("@/app/api/settings/skills/route");
    const { status, json } = await callRoute(GET, new Request("http://localhost/api/settings/skills"));
    expect(status).toBe(200);
    const bundled = json.skills?.find((s) => s.id === "tagged-bundled");
    const user = json.skills?.find((s) => s.id === "tagged-user");
    expect(Array.isArray(bundled?.tags)).toBe(true);
    expect(bundled?.tags).toEqual(["video", "ai"]);
    expect(Array.isArray(user?.tags)).toBe(true);
    expect(user?.tags).toEqual(["editing"]);
    expect(Array.isArray(bundled?.prompts)).toBe(true);
    expect(Array.isArray(user?.prompts)).toBe(true);
  });

  it("PATCH updates tags for a bundled skill (DB-only)", async () => {
    getDb().insert(skills).values({
      id: "bundled-tags",
      name: "bundled-tags",
      description: "bundled",
      source: "bundled",
      enabled: true,
      tags: JSON.stringify([]),
    }).run();
    const { PATCH } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/bundled-tags", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["video", "ai"] }),
    });
    const { status, json } = await callRoute(PATCH, req, { params: Promise.resolve({ id: "bundled-tags" }) });
    expect(status).toBe(200);
    expect(json.skill?.tags).toEqual(["video", "ai"]);
    const row = getDb().select().from(skills).where(eq(skills.id, "bundled-tags")).get();
    expect(JSON.parse(row!.tags)).toEqual(["video", "ai"]);
  });

  it("POST persists frontmatter tags to the DB tags column", async () => {
    const { POST } = await import("@/app/api/settings/skills/route");
    const bodyWithTags = `---\nname: tagged-create\ndescription: Tag create test\ntags:\n  - foo\n  - bar\n---\nBody.\n`;
    const req = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tagged-create", description: "Tag create test", body: bodyWithTags }),
    });
    const { status, json } = await callRoute(POST, req);
    expect(status).toBe(201);
    const row = getDb().select().from(skills).where(eq(skills.id, json.skill!.id)).get();
    expect(row).toBeDefined();
    const storedTags = JSON.parse(row!.tags) as string[];
    expect(storedTags).toContain("foo");
    expect(storedTags).toContain("bar");
  });

  it("PATCH content-update persists updated frontmatter tags to the DB tags column", async () => {
    const { POST } = await import("@/app/api/settings/skills/route");
    const { PATCH } = await import("@/app/api/settings/skills/[id]/route");
    // Create with one set of tags
    const initialBody = `---\nname: tag-update-test\ndescription: Tag update test\ntags:\n  - old-tag\n---\nBody.\n`;
    const postReq = new Request("http://localhost/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tag-update-test", description: "Tag update test", body: initialBody }),
    });
    const { json: postJson } = await callRoute(POST, postReq);
    const skillId = postJson.skill!.id;

    // PATCH content-update with new frontmatter tags
    const updatedBody = `---\nname: tag-update-test\ndescription: Tag update test\ntags:\n  - new-tag\n---\nBody.\n`;
    const patchReq = new Request(`http://localhost/api/settings/skills/${skillId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tag-update-test", description: "Tag update test", body: updatedBody }),
    });
    await callRoute(PATCH, patchReq, { params: Promise.resolve({ id: skillId }) });

    const row = getDb().select().from(skills).where(eq(skills.id, skillId)).get();
    const storedTags = JSON.parse(row!.tags) as string[];
    expect(storedTags).toContain("new-tag");
    expect(storedTags).not.toContain("old-tag");
  });

  it("PATCH updates tags for a user skill (DB + file)", async () => {
    const dir = path.join(homeRoot, "skills/user-tagme");
    fs.mkdirSync(dir, { recursive: true });
    const skillBody = `---\nname: user-tagme\ndescription: Tag me skill\ntags: []\n---\nBody.\n`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillBody);
    getDb().insert(skills).values({
      id: "user-tagme",
      name: "user-tagme",
      description: "Tag me skill",
      source: "user",
      enabled: true,
      body: skillBody,
      tags: JSON.stringify([]),
    }).run();
    const { PATCH } = await import("@/app/api/settings/skills/[id]/route");
    const req = new Request("http://localhost/api/settings/skills/user-tagme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["editing", "export"] }),
    });
    const { status, json } = await callRoute(PATCH, req, { params: Promise.resolve({ id: "user-tagme" }) });
    expect(status).toBe(200);
    expect(json.skill?.tags).toEqual(["editing", "export"]);
    const row = getDb().select().from(skills).where(eq(skills.id, "user-tagme")).get();
    expect(JSON.parse(row!.tags)).toEqual(["editing", "export"]);
    const onDisk = fs.readFileSync(path.join(homeRoot, "skills/user-tagme/SKILL.md"), "utf-8");
    expect(onDisk).toContain("editing");
  });
});
