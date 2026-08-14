/**
 * POST /api/install-from-url
 *
 * Body: { url: string, selectedPaths?: string[] }
 *
 * Orchestrator for the install-from-URL flow. The shape of the
 * response varies by what the URL points at:
 *
 *   - `{ kind: "claude-plugin", result: InstallResult }`
 *   - `{ kind: "single-skill", result: InstallResult }`
 *   - `{ kind: "multi-skill", manifest: { name, relPath }[] }`
 *       (first call — UI shows checkboxes, calls again with selectedPaths)
 *   - `{ kind: "multi-skill", result: InstallResult }`
 *       (second call with selectedPaths)
 *   - `{ kind: "handed-off", sessionId }`
 *   - `{ error, hint? }` with appropriate status code on failure
 *
 * The temp tarball is always cleaned in `finally`.
 */

import { NextResponse } from "next/server";
import {
  cleanupBasePath,
  detectCandidate,
  fetchRepoTarball,
  parseGithubUrl,
} from "@/lib/install-from-url/detect";
import { installClaudePlugin } from "@/lib/install-from-url/install-plugin";
import { installSingleSkill } from "@/lib/install-from-url/install-skill";
import { handOffToAgent } from "@/lib/install-from-url/handoff-agent";
import {
  NoAgentConfiguredError,
  SkillCollisionError,
  type InstallResult,
} from "@/lib/install-from-url/types";
import { serverLogger as logger } from "@/lib/logger";

export async function POST(request: Request) {
  let body: { url?: string; selectedPaths?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const url = body.url;
  if (!url || typeof url !== "string") {
    return NextResponse.json(
      { error: "url is required" },
      { status: 400 },
    );
  }

  const ref = parseGithubUrl(url);
  if (!ref) {
    return NextResponse.json(
      {
        error: "invalid GitHub URL",
        hint: "Expected https://github.com/owner/repo or https://github.com/owner/repo/tree/<ref>/sub/path",
      },
      { status: 400 },
    );
  }

  logger.info(
    {
      tag: "install-from-url",
      op: "route_start",
      url,
      owner: ref.owner,
      repo: ref.repo,
      ref: ref.ref,
      subPath: ref.subPath,
      hasSelectedPaths: !!body.selectedPaths,
    },
    "install-from-url request",
  );

  let basePath: string | null = null;
  try {
    let fetched;
    try {
      fetched = await fetchRepoTarball(ref);
    } catch (err) {
      logger.error(
        { tag: "install-from-url", op: "fetch_error", err },
        "Tarball fetch failed",
      );
      return NextResponse.json(
        {
          error: "failed to download repository",
          hint: (err as Error).message,
        },
        { status: 502 },
      );
    }
    basePath = fetched.basePath;

    const candidate = await detectCandidate(basePath);

    switch (candidate.kind) {
      case "claude-plugin": {
        const result = await installClaudePlugin({
          basePath,
          manifest: candidate.manifest,
        });
        return NextResponse.json({ kind: "claude-plugin", result });
      }

      case "single-skill": {
        try {
          const installed = await installSingleSkill({
            basePath,
            skillRelPath: candidate.skillPath,
            name: candidate.name,
          });
          const result: InstallResult = {
            installed: [installed],
            failed: [],
          };
          return NextResponse.json({ kind: "single-skill", result });
        } catch (err) {
          if (err instanceof SkillCollisionError) {
            return NextResponse.json(
              { error: err.message, hint: "Remove or rename the existing user skill first." },
              { status: 409 },
            );
          }
          throw err;
        }
      }

      case "multi-skill": {
        // Two-stage: if no selectedPaths, return the candidate list.
        if (!body.selectedPaths || body.selectedPaths.length === 0) {
          return NextResponse.json({
            kind: "multi-skill",
            manifest: candidate.skills,
          });
        }
        // Second-stage: install only the requested ones.
        const result: InstallResult = { installed: [], failed: [] };
        const known = new Map(candidate.skills.map((s) => [s.relPath, s] as const));
        for (const relPath of body.selectedPaths) {
          const spec = known.get(relPath);
          if (!spec) {
            result.failed.push({
              kind: "skill",
              name: relPath,
              error: `relPath not present in repo: ${relPath}`,
            });
            continue;
          }
          try {
            const installed = await installSingleSkill({
              basePath,
              skillRelPath: spec.relPath,
              name: spec.name,
            });
            result.installed.push(installed);
          } catch (err) {
            result.failed.push({
              kind: "skill",
              name: spec.name,
              error:
                err instanceof SkillCollisionError
                  ? "already installed — remove the existing user skill or rename"
                  : (err as Error).message,
            });
          }
        }
        return NextResponse.json({ kind: "multi-skill", result });
      }

      case "unknown": {
        try {
          const { sessionId } = await handOffToAgent({ url });
          return NextResponse.json({
            kind: "handed-off",
            sessionId,
            reason: candidate.reason,
          });
        } catch (err) {
          if (err instanceof NoAgentConfiguredError) {
            return NextResponse.json(
              { error: err.message },
              { status: 400 },
            );
          }
          throw err;
        }
      }

      default: {
        // Exhaustiveness fallback — should be unreachable.
        return NextResponse.json(
          { error: "unrecognized candidate kind" },
          { status: 500 },
        );
      }
    }
  } catch (err) {
    logger.error(
      { tag: "install-from-url", op: "route_error", err },
      "install-from-url request failed",
    );
    return NextResponse.json(
      {
        error: (err as Error).message ?? "internal error",
      },
      { status: 500 },
    );
  } finally {
    if (basePath) {
      await cleanupBasePath(basePath);
    }
  }
}
