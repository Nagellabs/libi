// lib/agents/adapter-copy.ts
//
// What libi tells the user about the download that lets an agent run in libi's
// own chat: the ACP adapter package for Claude Code or Codex. The user's CLI is
// theirs and may well be installed already; this download is libi's, so every
// surface that describes it says "download", never "install" — a user who was
// just told their CLI is installed must not then read that libi is installing it.
//
// A leaf with nothing but a type import, so the setup wizard (client) and
// `adapter-tree.ts` (server) read the same words and the same size.
import type { RuntimeAgentPackage } from "./runtime-packages";

/**
 * User-facing name and download size per adapter. The size is the adapter's JS
 * tree as a real `npm install --omit=optional` lands it — the engines are never
 * downloaded — and matches the progress bar's `estimatedInstallBytes`, so a user
 * who sees both sees one number. Name and size live here rather than on
 * `RuntimeAgentPackage` because they are presentation, and that module stays a leaf.
 */
const ADAPTER_DOWNLOADS: Record<RuntimeAgentPackage["agentId"], { name: string; size: string }> = {
  "claude-code": { name: "Claude Code", size: "56 MB" },
  codex: { name: "Codex", size: "17 MB" },
};

export interface AdapterDownloadCopy {
  /** Before and during the download: why libi downloads anything, and how much, once. */
  needed: string;
  /** Before the download job is running — the automatic start, a moment long. Never says "Downloading". */
  starting: string;
  /** A start that hasn't turned into a download after a few seconds; Retry download sits beside it. */
  stalled: string;
  /** While the download runs; the wizard shows its MB progress beside it. */
  downloading: string;
  downloaded: string;
  failed: string;
  cancelled: string;
  /** The agent selector's reasons for a disabled agent (`adapterUnavailableReason`). */
  unavailableDownloading: string;
  unavailableFailed: string;
  unavailableMissing: string;
}

export function adapterDownloadCopy(agentId: RuntimeAgentPackage["agentId"]): AdapterDownloadCopy {
  const { name, size } = ADAPTER_DOWNLOADS[agentId];
  return {
    needed: `libi needs to download ${name} support to run it in libi's chat (${size}, one time).`,
    starting: `Starting to download ${name} support…`,
    stalled: `${name} support didn't start downloading.`,
    downloading: `Downloading ${name} support…`,
    downloaded: `${name} support is downloaded.`,
    failed: `Couldn't download ${name} support.`,
    cancelled: `Downloading ${name} support was cancelled.`,
    unavailableDownloading: `Downloading ${name} support (${size}) — this can take a few minutes.`,
    unavailableFailed: `Couldn't download ${name} support — retry from Agents.`,
    unavailableMissing: `${name} support isn't downloaded yet — set it up in Agents.`,
  };
}
