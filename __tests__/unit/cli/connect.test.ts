import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConnectDir, resolveConnectUrl, claudeMcpAddArgs, codexMcpAddArgs, cleanupLegacyConnectFiles, runConnect, type ConnectDeps } from "@/lib/cli/connect";
import { packageRoot } from "@/lib/runtime/package-root";
import type { AddSkillInstallInput, SkillInstallView } from "@/lib/agents/skill-installs-types";

function project(mcpServers: Record<string, unknown>, dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connect-")))): string {
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers }));
  return dir;
}
const servers = (dir: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8")) as { mcpServers: Record<string, unknown> }).mcpServers;

describe("resolveConnectDir", () => {
  it("defaults to LIBI_LAUNCH_CWD, then process.cwd()", () => {
    expect(resolveConnectDir(undefined, { LIBI_LAUNCH_CWD: "/me/proj" })).toBe("/me/proj");
    expect(resolveConnectDir(undefined, {})).toBe(process.cwd());
  });
  it("resolves a relative arg against the launch cwd", () => {
    expect(resolveConnectDir("../x", { LIBI_LAUNCH_CWD: "/me/proj" })).toBe(path.resolve("/me/proj", "../x"));
  });
});

describe("resolveConnectUrl", () => {
  it("uses the mcp-port file when libi is running", () => {
    expect(resolveConnectUrl({} as NodeJS.ProcessEnv, () => "3999")).toEqual({ url: "http://127.0.0.1:3999/mcp", running: true });
  });
  it("falls back to the default port when not running", () => {
    expect(resolveConnectUrl({} as NodeJS.ProcessEnv, () => null)).toEqual({ url: "http://127.0.0.1:3457/mcp", running: false });
    expect(resolveConnectUrl({ LIBI_MCP_PORT: "4100" } as unknown as NodeJS.ProcessEnv, () => null).url).toBe("http://127.0.0.1:4100/mcp");
  });
});

describe("mcp add argument builders", () => {
  it("claude: always the user scope, whatever the folder", () => {
    expect(claudeMcpAddArgs("http://127.0.0.1:3457/mcp")).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "libi", "http://127.0.0.1:3457/mcp"]);
  });
  it("codex: url form with the codex dialect", () => {
    expect(codexMcpAddArgs("http://127.0.0.1:3457/mcp")).toEqual(["mcp", "add", "libi", "--url", "http://127.0.0.1:3457/mcp?agent=codex"]);
  });
});

describe("cleanupLegacyConnectFiles", () => {
  const LIBI_ROOTS = ["/opt/libi"];
  const HOME = path.join(os.homedir(), ".libi");

  it("removes entries libi wrote — an in-tree command, or an env.LIBI_HOME pin", () => {
    const dir = project({
      // What `--connect-agent` wrote for libi itself: absolute command in tree.
      libi: { command: "/opt/libi/node_modules/.bin/node", args: ["/opt/libi/mcp/index.ts"] },
      // Bare `node` (no managed node install) — the tree path is in args.
      "fal-ai": { command: "node", args: ["/opt/libi/node_modules/fal-mcp/cli.js"] },
      // `buildReferenceServerEnv` pinned LIBI_HOME on EVERY stdio entry it wrote.
      ElevenLabs: { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}", LIBI_HOME: HOME } },
      // No `requiredEnvVars`, so no `${VAR}` ever — the LIBI_HOME pin is the
      // ONLY thing that identifies it, and the old heuristic missed it.
      "YouTube Downloader": { command: "npx", args: ["-y", "@kevinwatt/yt-dlp-mcp"], env: { PATH: "/usr/bin", LIBI_HOME: HOME } },
    });
    const touched = cleanupLegacyConnectFiles(dir, LIBI_ROOTS);
    expect(touched).toEqual([path.join(dir, ".mcp.json")]);
    expect(servers(dir)).toEqual({});
  });

  // `fal-ai`, `ElevenLabs`, `YouTube Downloader` are exactly the names a user
  // would give their OWN registration of the same upstream, and the cleanup
  // once deleted on name alone. The name plays no part any more: only the
  // fingerprint decides, which is also what protects a user-owned `libi`.
  it("keeps a user's own entry that merely SHARES a managed name", () => {
    const dir = project({
      "fal-ai": { command: "/usr/local/bin/something", args: ["--serve"] },
      ElevenLabs: { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "sk-my-real-key" } },
      "YouTube Downloader": { type: "http", url: "https://mine", headers: { Authorization: "Bearer literal" } },
      libi: { command: "/usr/local/bin/my-own-libi" },
    });
    const before = servers(dir);
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([]);
    expect(servers(dir)).toEqual(before);
  });

  // `${VAR}` is Claude Code's documented env-expansion idiom, so it says
  // nothing about who wrote the entry. It used to be a delete trigger.
  it("a ${VAR} env or header, alone, is not a fingerprint", () => {
    const dir = project({
      ElevenLabs: { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}" } },
      "fal-ai": { type: "http", url: "https://fal.run/mcp", headers: { Authorization: "Bearer ${FAL_KEY}" } },
    });
    const before = servers(dir);
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([]);
    expect(servers(dir)).toEqual(before);
  });

  it("a LIBI_HOME pointing at some unrelated dir is not a fingerprint", () => {
    const dir = project({
      ElevenLabs: { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { LIBI_HOME: "/Users/me/app/somewhere-else" } },
    });
    const before = servers(dir);
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([]);
    expect(servers(dir)).toEqual(before);
  });

  // The cleanup used to require the name to be on a managed-names list AS
  // WELL. Since migration 0051 that list was the constant {"libi"} — the name
  // `libi connect` itself writes — so a pre-HTTP `.mcp.json` kept its
  // `fal-ai` / `ElevenLabs` / `YouTube Downloader` entries forever, each one
  // pinning LIBI_HOME or spawning a binary out of libi's tree. The fingerprint
  // is conclusive on its own; a name is never consulted, and the by-name
  // allowlist was deleted for exactly that reason.
  it("removes libi's own pre-HTTP fal-ai — its name is not managed, its LIBI_HOME pin is the tell", () => {
    const dir = project({
      "fal-ai": { command: "npx", args: ["-y", "fal-mcp"], env: { FAL_KEY: "${FAL_KEY}", LIBI_HOME: HOME } },
    });
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([path.join(dir, ".mcp.json")]);
    expect(servers(dir)).toEqual({});
  });

  it("keeps a user-owned fal-ai — the HTTP upstream with their own bearer header, no pin, no in-tree path", () => {
    const entry = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer sk-mine-42" } };
    const dir = project({ "fal-ai": entry });
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([]);
    expect(servers(dir)).toEqual({ "fal-ai": entry });
  });

  it("judges an entry under ANY name by its fingerprint alone", () => {
    const dir = project({
      mine: { command: "/opt/libi/node_modules/.bin/node", env: { LIBI_HOME: HOME } },
      theirs: { command: "/usr/local/bin/node", env: { LIBI_HOME: "/Users/me/app/somewhere-else" } },
    });
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([path.join(dir, ".mcp.json")]);
    expect(servers(dir)).toEqual({ theirs: { command: "/usr/local/bin/node", env: { LIBI_HOME: "/Users/me/app/somewhere-else" } } });
  });

  it("removes only the libi-written half of a mixed file, and drops enableAllProjectMcpServers", () => {
    const dir = project({
      libi: { command: "/opt/libi/node_modules/.bin/node", args: ["/opt/libi/mcp/index.ts"] },
      "fal-ai": { command: "/usr/local/bin/something" },
      mine: { command: "me" },
    });
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true, other: 1 }));
    const touched = cleanupLegacyConnectFiles(dir, LIBI_ROOTS);
    expect(touched.length).toBe(2);
    expect(servers(dir)).toEqual({ "fal-ai": { command: "/usr/local/bin/something" }, mine: { command: "me" } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf-8"))).toEqual({ other: 1 });
  });

  it("is a no-op when the files do not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
    expect(cleanupLegacyConnectFiles(dir, LIBI_ROOTS)).toEqual([]);
  });
});

/**
 * The DEFAULT roots, with `process.cwd()` where `libi connect` really leaves
 * it: the user's folder. `bin/libi.js` chdirs only in a dev checkout, so under
 * an installed `npx @nagellabs/libi connect` cwd IS the folder being connected.
 * While the default came from `libiTreeRoots()` — whose cwd walk always
 * includes the start dir — that folder was a "libi root", and a user's own
 * entry pointing at their own file inside it was deleted. Every test here
 * injects nothing; the point is the default.
 */
describe("cleanupLegacyConnectFiles — default roots, cwd = the connect dir", () => {
  const realHome = process.env.LIBI_HOME;
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-home-")));
    process.env.LIBI_HOME = home;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "user-proj-")));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (realHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = realHome;
  });

  it("keeps a user's own fal-ai whose absolute arg lives under the connect dir", () => {
    expect(process.cwd()).toBe(dir);
    const entry = { command: "node", args: [path.join(dir, "mcp", "fal-proxy.js")] };
    project({ "fal-ai": entry }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([]);
    expect(servers(dir)).toEqual({ "fal-ai": entry });
  });

  it("keeps a user's own ElevenLabs with the documented ${VAR} env form", () => {
    const entry = { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}" } };
    project({ ElevenLabs: entry }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([]);
    expect(servers(dir)).toEqual({ ElevenLabs: entry });
  });

  it("removes an old libi-written YouTube Downloader — bare npx, env.LIBI_HOME pin", () => {
    project({ "YouTube Downloader": { command: "npx", args: ["-y", "@kevinwatt/yt-dlp-mcp"], env: { PATH: "/usr/bin", LIBI_HOME: home } } }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([path.join(dir, ".mcp.json")]);
    expect(servers(dir)).toEqual({});
  });

  it("removes an old libi entry whose absolute command sits in libi's package root", () => {
    project({ libi: { command: path.join(packageRoot(__dirname), "node_modules", ".bin", "node"), args: ["--stdio"] } }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([path.join(dir, ".mcp.json")]);
    expect(servers(dir)).toEqual({});
  });

  it("a LIBI_HOME pointing at an unrelated dir is not a fingerprint", () => {
    const entry = { command: "npx", args: ["-y", "elevenlabs-mcp"], env: { LIBI_HOME: path.join(dir, "state") } };
    project({ ElevenLabs: entry }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([]);
    expect(servers(dir)).toEqual({ ElevenLabs: entry });
  });

  // Belt and braces: even a LIBI_HOME that IS the connect dir must not make
  // the user's own folder libi's turf for deletion purposes.
  it("drops a root that IS the folder being connected", () => {
    process.env.LIBI_HOME = dir;
    const entry = { command: path.join(dir, "bin", "my-mcp"), args: ["--serve"] };
    project({ "fal-ai": entry }, dir);
    expect(cleanupLegacyConnectFiles(dir)).toEqual([]);
    expect(servers(dir)).toEqual({ "fal-ai": entry });
  });
});

function view(over: Partial<SkillInstallView>): SkillInstallView {
  return { id: "x", agentId: "claude-code", scope: "folder", path: "/me/proj/.claude/skills", folderPath: "/me/proj", source: "cli", status: "up-to-date", error: null, skippedNames: [], installedCount: 30, lastSyncedAt: null, ...over };
}

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps & { run: ReturnType<typeof vi.fn>; installSkills: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({ ok: true, stderr: "" }));
  const installSkills = vi.fn(async (input: AddSkillInstallInput) =>
    input.scope === "user"
      ? view({ agentId: input.agentId, scope: "user", folderPath: null, path: input.agentId === "codex" ? "/home/me/.agents/skills" : "/home/me/.claude/skills" })
      : view({ agentId: input.agentId, folderPath: input.folderPath, path: `${input.folderPath}/${input.agentId === "codex" ? ".agents" : ".claude"}/skills` }),
  );
  return {
    findClaude: () => ({ kind: "user", path: "/usr/local/bin/claude" }),
    findCodex: () => ({ kind: "user", path: "/usr/local/bin/codex" }),
    run,
    installSkills,
    listInstalls: vi.fn(async () => []),
    ...over,
  } as ConnectDeps & { run: ReturnType<typeof vi.fn>; installSkills: ReturnType<typeof vi.fn> };
}

describe("runConnect", () => {
  it("registers both CLIs (Claude in the user scope), installs skills for both agents in the folder, cleans legacy files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
    const d = deps();
    const steps = await runConnect({ dir, global: false, url: "http://127.0.0.1:3457/mcp", running: true }, d);
    expect(d.run).toHaveBeenCalledWith("/usr/local/bin/claude", claudeMcpAddArgs("http://127.0.0.1:3457/mcp"), dir);
    expect(d.run).toHaveBeenCalledWith("/usr/local/bin/codex", codexMcpAddArgs("http://127.0.0.1:3457/mcp"), dir);
    expect(d.installSkills).toHaveBeenCalledWith({ agentId: "claude-code", scope: "folder", folderPath: dir, source: "cli" });
    expect(d.installSkills).toHaveBeenCalledWith({ agentId: "codex", scope: "folder", folderPath: dir, source: "cli" });
    expect(steps.map((s) => [s.id, s.status])).toEqual([["claude", "done"], ["codex", "done"], ["skills", "done"], ["skills", "done"], ["legacy", "skipped"]]);
    expect(steps[2].detail).toBe(`Claude Code skills: 30 skills in ${dir}/.claude/skills`);
    expect(steps[3].detail).toBe(`Codex skills: 30 skills in ${dir}/.agents/skills`);
  });
  it("names the skills it skipped because the user already has them", async () => {
    const d = deps({ installSkills: vi.fn(async (input: AddSkillInstallInput) => view({ agentId: input.agentId, skippedNames: ["captions", "ugc"], installedCount: 28 })) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[2].detail).toBe("Claude Code skills: 28 skills in /me/proj/.claude/skills — skipped 2 you already use: captions, ugc");
  });
  it("one skill installed, or one skipped, reads in the singular", async () => {
    const d = deps({ installSkills: vi.fn(async (input: AddSkillInstallInput) => view({ agentId: input.agentId, skippedNames: ["captions"], installedCount: 1 })) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[2].detail).toBe("Claude Code skills: 1 skill in /me/proj/.claude/skills — skipped 1 you already use: captions");
  });
  it("tells the user codex rewrote their config, and where the copy is", async () => {
    // Disclosure at the point of action. codex re-serializes the whole
    // config.toml on `mcp add` and `mcp remove` does not undo it, so a user
    // whose hand-written TOML has just been reformatted needs to be told, and
    // needs the path to what it looked like before.
    const d = deps({
      run: vi.fn(async (bin: string) =>
        bin.includes("codex")
          ? { ok: true, stderr: "", configBackup: "/home/me/.codex/config.toml.libi-backup-X" }
          : { ok: true, stderr: "" },
      ) as ConnectDeps["run"],
    });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    const codex = steps.find((s) => s.id === "codex");
    expect(codex).toMatchObject({ status: "done" });
    expect(codex!.detail).toContain("codex rewrote your config.toml");
    expect(codex!.detail).toContain("/home/me/.codex/config.toml.libi-backup-X");
    // Claude's line is untouched — nothing rewrote anything there.
    expect(steps.find((s) => s.id === "claude")!.detail).not.toContain("config.toml");
  });

  it("says nothing about a rewrite when no copy was taken", async () => {
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, deps());
    expect(steps.find((s) => s.id === "codex")!.detail).not.toContain("config.toml");
  });

  it("--global installs user-level skills for both agents and reports each folder install it replaced", async () => {
    const d = deps({
      listInstalls: vi.fn(async () => [view({ id: "old", agentId: "claude-code", folderPath: "/me/old", path: "/me/old/.claude/skills" })]),
    });
    const steps = await runConnect({ dir: "/me/proj", global: true, url: "u", running: true }, d);
    expect(d.run).toHaveBeenCalledWith("/usr/local/bin/claude", claudeMcpAddArgs("u"), "/me/proj");
    expect(d.installSkills).toHaveBeenCalledWith({ agentId: "claude-code", scope: "user", source: "cli" });
    expect(d.installSkills).toHaveBeenCalledWith({ agentId: "codex", scope: "user", source: "cli" });
    const skills = steps.filter((s) => s.id === "skills").map((s) => [s.status, s.detail]);
    expect(skills).toEqual([
      ["printed", "Claude Code skills: removed from /me/old/.claude/skills — every folder has them now"],
      ["done", "Claude Code skills: 30 skills in /home/me/.claude/skills (every folder)"],
      ["done", "Codex skills: 30 skills in /home/me/.agents/skills (every folder)"],
    ]);
    expect(steps.find((s) => s.id === "legacy")?.status).toBe("skipped");
  });
  it("a folder connect for an agent that already has every-folder skills skips that agent and says why", async () => {
    const { SkillInstallError } = await import("@/mcp/skills/installs");
    const d = deps({
      installSkills: vi.fn(async (input: AddSkillInstallInput) => {
        if (input.agentId === "claude-code") throw new SkillInstallError("user_level_installed", "Skills are installed for every folder, so every folder already has them.");
        return view({ agentId: "codex", path: "/me/proj/.agents/skills" });
      }),
    });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[2]).toEqual({ id: "skills", agentId: "claude-code", status: "skipped", detail: "Claude Code skills: not installed here — Skills are installed for every folder, so every folder already has them." });
    expect(steps[3]).toMatchObject({ id: "skills", agentId: "codex", status: "done" });
  });
  it("a home-folder refusal prints the CLI's own line, not the service's UI wording plus a hint", async () => {
    const { SkillInstallError } = await import("@/mcp/skills/installs");
    const d = deps({ installSkills: vi.fn(async () => { throw new SkillInstallError("refused_home", "That's your home folder. To install libi's skills for every folder, choose Every folder."); }) });
    const steps = await runConnect({ dir: "/home/me", global: false, url: "u", running: true }, d);
    expect(steps[2]).toMatchObject({
      status: "printed",
      detail: "Claude Code skills: That's your home folder — run libi connect --global to install libi's skills for every folder.",
      failed: true,
    });
  });
  it("a folder validation failure that isn't refused_home prints the message alone, no --global suggestion", async () => {
    const { SkillInstallError } = await import("@/mcp/skills/installs");
    const d = deps({
      installSkills: vi.fn(async () => {
        throw new SkillInstallError("refused_libi_home", "That folder is libi's own data folder. libi's own chats and terminal already have libi's skills.");
      }),
    });
    const steps = await runConnect({ dir: "/me/libi-home", global: false, url: "u", running: true }, d);
    expect(steps[2]).toEqual({
      id: "skills",
      agentId: "claude-code",
      status: "printed",
      detail: "Claude Code skills: That folder is libi's own data folder. libi's own chats and terminal already have libi's skills.",
      failed: true,
    });
  });
  // The service keeps folder installs on a failed --global add (both when the
  // write itself fails, and when removing the folder installs fails) — see
  // `mcp/skills/installs.ts#addUserInstall`. Printing "removed from …" ahead
  // of the add, unconditionally, would claim that on a failure too.
  it("--global with a failing add does not claim folders were removed, and does not suggest --global", async () => {
    const { SkillInstallError } = await import("@/mcp/skills/installs");
    const d = deps({
      listInstalls: vi.fn(async () => [view({ id: "old", agentId: "claude-code", folderPath: "/me/old", path: "/me/old/.claude/skills" })]),
      installSkills: vi.fn(async () => {
        throw new SkillInstallError(
          "not_writable",
          "libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept.",
        );
      }),
    });
    const steps = await runConnect({ dir: "/me/proj", global: true, url: "u", running: true }, d);
    const claude = steps.filter((s) => s.id === "skills" && s.agentId === "claude-code");
    expect(claude).toEqual([
      {
        id: "skills",
        agentId: "claude-code",
        status: "printed",
        detail: "Claude Code skills: libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept.",
        failed: true,
      },
    ]);
  });
  it("an unknown_agent error is reported without the 're-run libi connect' advice", async () => {
    const { SkillInstallError } = await import("@/mcp/skills/installs");
    const d = deps({ installSkills: vi.fn(async () => { throw new SkillInstallError("unknown_agent", "Unknown agent."); }) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[2]).toEqual({ id: "skills", agentId: "claude-code", status: "printed", detail: "Claude Code skills: could not install (Unknown agent.)", failed: true });
  });
  it("prints the command instead when a CLI is missing or libi-internal", async () => {
    const d = deps({ findClaude: () => ({ kind: "none" }), findCodex: () => ({ kind: "libi-internal", path: "/repo/.bin/codex" }) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: false }, d);
    expect(d.run).not.toHaveBeenCalled();
    expect(steps[0]).toMatchObject({ id: "claude", status: "printed" });
    expect(steps[0].detail).toContain("claude mcp add --transport http --scope user libi u");
    expect(steps[0].detail).toContain("claude is not on your PATH — run this yourself once claude is installed:");
    expect(steps[1]).toMatchObject({ id: "codex", status: "printed" });
    expect(steps[1].detail).toContain("the only codex on your PATH is libi's bundled copy — install codex yourself, then run:");
  });
  it("a failing mcp add is reported, not thrown", async () => {
    const d = deps({ run: vi.fn(async () => ({ ok: false, stderr: "boom" })) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[0]).toMatchObject({ id: "claude", status: "printed" });
    expect(steps[0].detail).toContain("boom");
  });
  it("a rejecting `run` dep is reported, not thrown", async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error("spawn ENOENT"); }) });
    const steps = await runConnect({ dir: "/me/proj", global: false, url: "u", running: true }, d);
    expect(steps[0]).toMatchObject({ id: "claude", status: "printed" });
    expect(steps[0].detail).toContain("claude mcp add could not run (spawn ENOENT) — run it yourself:");
    expect(steps[0].detail).toContain("--scope user");
  });
  it("a rejecting install (no migrated DB) is reported, not thrown, and the legacy step still runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
    const d = deps({ installSkills: vi.fn(async () => { throw new Error("no such table: skills"); }) });
    const steps = await runConnect({ dir, global: false, url: "u", running: true }, d);
    expect(steps[2]).toMatchObject({ id: "skills", status: "printed", detail: "Claude Code skills: could not install (no such table: skills) — start libi once, then re-run libi connect" });
    // Skills were not installed, so the run fails like a refused install does:
    // `user_level_installed` is the only skip that leaves the exit code alone.
    expect(steps.filter((s) => s.id === "skills").map((s) => s.failed)).toEqual([true, true]);
    expect(steps.find((s) => s.id === "legacy")).toBeDefined();
  });
  it("--global with a rejecting `listInstalls` (no migrated DB) still reports installSkills's own failure, not thrown", async () => {
    const d = deps({
      listInstalls: vi.fn(async () => { throw new Error("no such table: skill_installs"); }),
      installSkills: vi.fn(async () => { throw new Error("no such table: skill_installs"); }),
    });
    const steps = await runConnect({ dir: "/me/proj", global: true, url: "u", running: true }, d);
    const skills = steps.filter((s) => s.id === "skills");
    expect(skills).toEqual([
      { id: "skills", agentId: "claude-code", status: "printed", detail: "Claude Code skills: could not install (no such table: skill_installs) — start libi once, then re-run libi connect", failed: true },
      { id: "skills", agentId: "codex", status: "printed", detail: "Codex skills: could not install (no such table: skill_installs) — start libi once, then re-run libi connect", failed: true },
    ]);
    expect(steps.find((s) => s.id === "legacy")).toBeDefined();
  });
});
