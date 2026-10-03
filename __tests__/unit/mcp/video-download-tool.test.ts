/**
 * `libi.download_video` (mcp/tools/video-download-tools.ts) — the agent-facing
 * half of the `video_download` job — and the `youtube-download` extension def
 * that replaced the third-party `youtube-downloader` MCP.
 *
 * `runJobViaServer` is mocked: the tool's own job is URL canonicalisation,
 * the first-use disclosure, and turning the job's outcome into a tool result.
 * The runner itself is covered by __tests__/unit/jobs/video-download-runner.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_MCP_SERVERS, extensionForToolName } from "@/mcp/registry/bundled";

vi.mock("@/mcp/jobs-client", () => ({
  runJobViaServer: vi.fn(),
  LibiServerUnavailableError: class extends Error {},
}));
vi.mock("@/mcp/notify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/mcp/notify")>();
  return { ...mod, notify: { ...mod.notify, toolProgress: vi.fn() } };
});
import { notify } from "@/mcp/notify";
import { runWithToolCallContext } from "@/mcp/tool-call-context";

import { runJobViaServer } from "@/mcp/jobs-client";
import {
  downloadVideo,
  canonicalizeVideoUrl,
  needsInstallMessage,
  YT_DLP_INSTALL_MB,
} from "@/mcp/tools/video-download-tools";
import { YT_DLP_UNAVAILABLE } from "@/lib/video-download/launcher";

const savedHome = process.env.LIBI_HOME;
let home: string;

/** The wrapper the yt-dlp-uv installer leaves in `<LIBI_HOME>/bin`. */
function writeWrapper(): void {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "yt-dlp"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
}

const completed = (result: Record<string, unknown>) =>
  ({ status: "completed", jobId: "j1", result }) as never;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dl-tool-"));
  process.env.LIBI_HOME = home;
  vi.mocked(runJobViaServer).mockReset();
  vi.mocked(notify.toolProgress).mockClear();
});

afterEach(() => {
  process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("libi.download_video", () => {
  it("dispatches the video_download job and returns the stored file", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockResolvedValue(
      completed({ fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 }),
    );

    const res = await downloadVideo({
      url: "https://www.youtube.com/watch?v=abc",
      pieceId: "p1",
      audioOnly: false,
    });

    expect(vi.mocked(runJobViaServer).mock.calls[0][0]).toBe("video_download");
    expect(vi.mocked(runJobViaServer).mock.calls[0][1]).toEqual({
      url: "https://www.youtube.com/watch?v=abc",
      pieceId: "p1",
      audioOnly: false,
    });
    // The job is filed under the piece so its row and progress attach to it.
    expect(vi.mocked(runJobViaServer).mock.calls[0][2]).toMatchObject({ pieceId: "p1" });
    expect(res).toEqual({
      success: true,
      data: { fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 },
    });
  });

  it("strips playlist/radio params before dispatching", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockResolvedValue(
      completed({ fileId: "f", filename: "a.mp4", title: "a", bytes: 1 }),
    );
    await downloadVideo({
      url: "https://www.youtube.com/watch?v=abc&list=RD123&start_radio=1&index=4&t=30",
      pieceId: null,
      audioOnly: false,
    });
    expect((vi.mocked(runJobViaServer).mock.calls[0][1] as { url: string }).url).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });

  it("reads the cached result back from a matching_completed job", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "j0",
        pieceId: null,
        completedAt: "2026-09-08T00:00:00Z",
        status: "completed",
        result: { fileId: "f0", filename: "old.mp4", title: "old", bytes: 7 },
      },
    } as never);
    const res = await downloadVideo({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
    expect(res).toEqual({
      success: true,
      data: { fileId: "f0", filename: "old.mp4", title: "old", bytes: 7 },
    });
  });

  it("discloses the first-use install when the yt-dlp wrapper is absent: a progress line before the job, and a flag on the result", async () => {
    // No writeWrapper(): a fresh machine. The runner installs uv + yt-dlp
    // inside the job; the tool's job is to say so.
    vi.mocked(runJobViaServer).mockResolvedValue(
      completed({ fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 }),
    );
    const sendNotification = vi.fn(async () => {});
    const extra = { _meta: { progressToken: "tok" }, sendNotification } as never;

    const res = await downloadVideo(
      { url: "https://www.youtube.com/watch?v=abc", pieceId: null, audioOnly: false },
      extra,
    );

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const params = sendNotification.mock.calls[0][0 as never] as unknown as {
      method: string;
      params: { progressToken: string; message: string };
    };
    expect(params.method).toBe("notifications/progress");
    expect(params.params.progressToken).toBe("tok");
    expect(params.params.message).toContain(`${YT_DLP_INSTALL_MB} MB`);
    // The disclosure is sent BEFORE the job runs, not after.
    expect(sendNotification.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runJobViaServer).mock.invocationCallOrder[0],
    );
    expect(res).toEqual({
      success: true,
      data: { fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42, ytDlpInstalled: true },
    });
  });

  it("the first-use disclosure also reaches the chat through the job_progress side channel", async () => {
    vi.mocked(runJobViaServer).mockResolvedValue(completed({ fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 }));
    const url = "https://www.youtube.com/watch?v=abc";
    await runWithToolCallContext("libi.download_video", { url }, () =>
      downloadVideo({ url, pieceId: null, audioOnly: false } as never, { sendNotification: vi.fn(async () => {}), _meta: { progressToken: 1 } } as never),
    );
    expect(notify.toolProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "libi.download_video", done: 0, total: YT_DLP_INSTALL_MB,
        message: `first video download installs uv + yt-dlp, ~${YT_DLP_INSTALL_MB} MB`,
      }),
    );
  });

  it("returns needs_install ONLY for the runner's marked could-not-install/repair failure, naming Agents → Libi MCP → Video download", async () => {
    vi.mocked(runJobViaServer).mockRejectedValue(
      new Error(
        `${YT_DLP_UNAVAILABLE} yt-dlp could not be started (exit 127) and reinstalling it failed: Failed to fetch https://pypi.org/simple/yt-dlp/`,
      ),
    );
    const res = await downloadVideo({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
    expect(res).toMatchObject({
      success: false,
      error: "needs_install",
      data: { extensionId: "youtube-download" },
    });
    const message = (res as unknown as { data: { message: string } }).data.message;
    // Says what failed, in the job's own words, marker stripped.
    expect(message).toContain("reinstalling it failed: Failed to fetch https://pypi.org/simple/yt-dlp/");
    expect(message).not.toContain(YT_DLP_UNAVAILABLE);
    // The right place — never Settings, which is where the old text sent users.
    expect(message).toContain("Agents → Libi MCP → Video download");
    expect(message).not.toMatch(/Settings/);
    // A retry once the user is online — and never a hand repair.
    expect(message).toMatch(/online/);
    expect(message).toMatch(/retry this tool ONCE/);
    expect(message).toMatch(/Do NOT edit, create or delete anything under ~\/\.libi\/bin/);
  });

  it("only suggests being offline when the cause reads as the network; anything else is relayed plainly", async () => {
    const plain = needsInstallMessage(
      "installing yt-dlp (needed to download videos) failed: OSError: [Errno 28] No space left on device",
    );
    expect(plain).toContain("No space left on device");
    expect(plain).not.toMatch(/online|network problem/i);
    expect(plain).toContain("Agents → Libi MCP → Video download");
    expect(plain).toMatch(/Do NOT edit, create or delete anything under ~\/\.libi\/bin/);
    expect(plain).not.toMatch(/Settings/);

    for (const cause of [
      "getaddrinfo ENOTFOUND github.com",
      "error sending request for url (https://pypi.org/simple/yt-dlp/): tcp connect error: Connection refused (os error 61)",
      "Failed to fetch: https://pypi.org/simple/certifi/",
    ]) {
      const net = needsInstallMessage(cause);
      expect(net, cause).toMatch(/network problem/);
      expect(net, cause).toMatch(/check they are online/);
      expect(net, cause).toContain(cause);
    }
  });

  it("does NOT call yt-dlp's own 'not found' / a bare ENOENT an install problem (the old regex did)", async () => {
    writeWrapper();
    for (const text of [
      "yt-dlp failed (exit 1): ERROR: [generic] Video not found",
      "spawn ENOENT",
    ]) {
      vi.mocked(runJobViaServer).mockRejectedValueOnce(new Error(text));
      const res = await downloadVideo({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
      expect(res, text).toEqual({ success: false, error: "download_failed", data: { message: text } });
    }
  });

  it("a launcher whose target is gone is a silent repair, not a first-use install disclosure", async () => {
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "yt-dlp"),
      `#!/bin/bash\nexec "${path.join(home, "worktrees", "gone", "yt-dlp")}" --no-playlist "$@"\n`,
      { mode: 0o755 },
    );
    vi.mocked(runJobViaServer).mockResolvedValue(
      completed({ fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 }),
    );
    const sendNotification = vi.fn(async () => {});
    const res = await downloadVideo(
      { url: "https://youtu.be/abc", pieceId: null, audioOnly: false },
      { _meta: { progressToken: "tok" }, sendNotification } as never,
    );
    expect(sendNotification).not.toHaveBeenCalled();
    expect(res).toEqual({
      success: true,
      data: { fileId: "f1", filename: "clip.mp4", title: "clip", bytes: 42 },
    });
  });

  it("the tool description and the needs_install text never send the user to Settings", () => {
    expect(needsInstallMessage("x")).not.toMatch(/Settings/);
    const server = fs.readFileSync(path.join(process.cwd(), "mcp", "server.ts"), "utf-8");
    const start = server.indexOf('"libi.download_video"');
    const desc = server.slice(start, server.indexOf("inputSchema", start));
    expect(desc).not.toMatch(/Settings/);
    expect(desc).toContain("Agents → Libi MCP → Video download");
    expect(desc).toMatch(/never edit files under ~\/\.libi\/bin/);
  });

  it("returns download_failed with the job's message for any other failure", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockRejectedValue(
      new Error("yt-dlp failed (exit 1): ERROR: [youtube] abc: Video unavailable"),
    );
    const res = await downloadVideo({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
    expect(res).toEqual({
      success: false,
      error: "download_failed",
      data: { message: "yt-dlp failed (exit 1): ERROR: [youtube] abc: Video unavailable" },
    });
  });
});

describe("libi.download_video search mode (agent-speed B4b)", () => {
  const PICKED = { title: "Fleetwood Mac - Dreams (Official Audio)", url: "https://www.youtube.com/watch?v=mrZRURcb1cM", durationSec: 257 };

  it("dispatches the job with the search (normalised, no url) and returns the picked result", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockResolvedValue(
      completed({ fileId: "f1", filename: "dreams.mp3", title: "dreams", bytes: 9, picked: PICKED }),
    );
    const res = await downloadVideo({ search: "  fleetwood mac   dreams official audio ", pieceId: "p1", audioOnly: true });
    expect(vi.mocked(runJobViaServer).mock.calls[0][0]).toBe("video_download");
    expect(vi.mocked(runJobViaServer).mock.calls[0][1]).toEqual({
      search: "fleetwood mac dreams official audio",
      pieceId: "p1",
      audioOnly: true,
    });
    expect(vi.mocked(runJobViaServer).mock.calls[0][2]).toMatchObject({ pieceId: "p1" });
    expect(res).toEqual({
      success: true,
      data: { fileId: "f1", filename: "dreams.mp3", title: "dreams", bytes: 9, picked: PICKED },
    });
  });

  it("refuses an empty or blank search, both url and search, and neither, without dispatching a job", async () => {
    writeWrapper();
    for (const params of [
      { search: "", pieceId: null, audioOnly: false },
      { search: " \n\t ", pieceId: null, audioOnly: false },
      { search: "x", url: "https://youtu.be/abc", pieceId: null, audioOnly: false },
      { pieceId: null, audioOnly: false },
    ]) {
      const res = await downloadVideo(params as never);
      expect(res).toMatchObject({ success: false, error: "download_failed" });
    }
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("discloses the first-use install for a search too", async () => {
    vi.mocked(runJobViaServer).mockResolvedValue(completed({ fileId: "f1", filename: "a.mp3", title: "a", bytes: 1, picked: PICKED }));
    const res = await downloadVideo({ search: "dreams", pieceId: null, audioOnly: true });
    expect(res).toMatchObject({ success: true, data: { ytDlpInstalled: true } });
  });

  describe("candidates: look before downloading", () => {
    const LIST = [
      { title: "Dreams (2004 Remaster)", url: "https://www.youtube.com/watch?v=5oWyMakvQew", durationSec: 258, uploader: "Fleetwood Mac" },
      { title: "Fleetwood Mac - Dreams (Official Audio)", url: "https://www.youtube.com/watch?v=PgagPdVM7bk", durationSec: 258, uploader: "Fleetwood Mac" },
    ];

    it("lists the top results through the same job, a fresh search every time, and downloads nothing", async () => {
      writeWrapper();
      vi.mocked(runJobViaServer).mockResolvedValue(completed({ candidates: LIST }));
      const res = await downloadVideo({ search: "  fleetwood mac   dreams official audio ", candidates: true } as never);
      const [kind, params, opts] = vi.mocked(runJobViaServer).mock.calls[0];
      expect(kind).toBe("video_download");
      expect(params).toEqual({ search: "fleetwood mac dreams official audio", candidates: 5, pieceId: null, audioOnly: false });
      expect(opts).toMatchObject({ forceNew: true });
      expect(res).toMatchObject({ success: true, data: { candidates: LIST, note: expect.stringMatching(/Nothing was downloaded.*url/) } });
      expect((res.data as Record<string, unknown>).fileId).toBeUndefined();
    });

    it("takes a count, needs no pieceId, and discloses the first-use install", async () => {
      vi.mocked(runJobViaServer).mockResolvedValue(completed({ candidates: LIST }));
      const res = await downloadVideo({ search: "dreams", candidates: true, count: 8 } as never);
      expect(vi.mocked(runJobViaServer).mock.calls[0][1]).toMatchObject({ candidates: 8 });
      expect(res).toMatchObject({ success: true, data: { ytDlpInstalled: true } });
    });

    it("refuses candidates with a url, and an empty result; a download still needs its pieceId", async () => {
      writeWrapper();
      expect(await downloadVideo({ url: "https://youtu.be/abc", candidates: true } as never)).toMatchObject({ success: false, data: { message: expect.stringMatching(/pass search/) } });
      expect(runJobViaServer).not.toHaveBeenCalled();
      vi.mocked(runJobViaServer).mockResolvedValue(completed({ candidates: [] }));
      expect(await downloadVideo({ search: "x", candidates: true } as never)).toMatchObject({ success: false, error: "download_failed" });
      expect(await downloadVideo({ search: "dreams", audioOnly: true } as never)).toMatchObject({ success: false, data: { message: expect.stringMatching(/pass pieceId/) } });
    });
  });

  it("url mode still sends exactly { url, pieceId, audioOnly }", async () => {
    writeWrapper();
    vi.mocked(runJobViaServer).mockResolvedValue(completed({ fileId: "f", filename: "a.mp4", title: "a", bytes: 1 }));
    await downloadVideo({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
    expect(vi.mocked(runJobViaServer).mock.calls[0][1]).toEqual({ url: "https://youtu.be/abc", pieceId: null, audioOnly: false });
  });
});

describe("canonicalizeVideoUrl", () => {
  it.each([
    ["watch with radio params", "https://www.youtube.com/watch?v=abc&list=RD123&start_radio=1&index=4&t=30&pp=x", "https://www.youtube.com/watch?v=abc"],
    ["mobile host", "https://m.youtube.com/watch?v=abc&t=5", "https://www.youtube.com/watch?v=abc"],
    ["music host", "https://music.youtube.com/watch?v=abc&list=PL1", "https://www.youtube.com/watch?v=abc"],
    ["bare host without www", "https://youtube.com/watch?v=abc", "https://www.youtube.com/watch?v=abc"],
    ["youtu.be short link", "https://youtu.be/abc?t=30&list=RD1", "https://youtu.be/abc"],
    ["YouTube without v (a playlist page) is left alone", "https://www.youtube.com/playlist?list=PL1", "https://www.youtube.com/playlist?list=PL1"],
    ["non-YouTube host is left alone", "https://vimeo.com/123?x=1", "https://vimeo.com/123?x=1"],
    ["unparseable input is returned verbatim", "not a url", "not a url"],
    // A Short is the same media as `watch?v=<id>` to yt-dlp, but its
    // share links carry `feature`/`si`/`t`, and `/shorts/` used to fall
    // through to `return raw` with all of them intact — so two share links
    // for one Short hashed differently and became two jobs.
    ["shorts share link", "https://www.youtube.com/shorts/abc?feature=share&si=xyz", "https://www.youtube.com/watch?v=abc"],
    ["shorts with a trailing slash", "https://youtube.com/shorts/abc/", "https://www.youtube.com/watch?v=abc"],
    ["shorts on the mobile host", "https://m.youtube.com/shorts/abc?t=3", "https://www.youtube.com/watch?v=abc"],
    ["a bare /shorts index is left alone (no id to canonicalise)", "https://www.youtube.com/shorts", "https://www.youtube.com/shorts"],
  ])("%s", (_name, input, expected) => {
    expect(canonicalizeVideoUrl(input)).toBe(expected);
  });

  it("folds a Short and its long-form URL onto the SAME string, so they dedupe together", () => {
    expect(canonicalizeVideoUrl("https://www.youtube.com/shorts/abc?si=one")).toBe(
      canonicalizeVideoUrl("https://www.youtube.com/watch?v=abc&t=12"),
    );
  });
});

describe("youtube-download extension def", () => {
  it("replaces the youtube-downloader MCP with a non-spawning extension", () => {
    const ids = BUNDLED_MCP_SERVERS.map((d) => d.id);
    expect(ids).not.toContain("youtube-downloader");
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === "youtube-download");
    expect(def).toBeDefined();
    expect(def!.kind).toBe("extension");
    expect(def!.noServer).toBe(true);
    expect(def!.npmPackage).toBeUndefined();
    expect(def!.installPlanPath).toBeUndefined();
    expect(def!.agentInstructions).toBeUndefined();
    expect(def!.installFlow).toBe("tier-2");
    expect(def!.dependencies.map((d) => [d.binary, d.installFlow])).toEqual([
      ["uv", "tier-2"],
      ["yt-dlp", "tier-2"],
    ]);
    // The row's description carries the same first-use figure the tool discloses.
    expect(def!.description).toContain(`${YT_DLP_INSTALL_MB} MB`);
  });

  it("owns libi.download_video", () => {
    expect(extensionForToolName("libi.download_video")?.id).toBe("youtube-download");
  });
});
