"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { uploadFileTo, type FileLocation } from "@/lib/queries/files";
import { TERMINAL_INSERT_TEXT_EVENT } from "@/lib/onboarding/demo";
import { buildInsertText, type ShellFlavor } from "@/lib/terminal/shell-quote";

interface Options {
  /**
   * Whether a terminal is mounted, attached and alive. Not cosmetic: the insert
   * is delivered by broadcasting on the window, and
   * `use-run-remedy-in-terminal.ts` records that a broadcast at a view which has
   * not mounted is heard by nobody, while a paste right after the socket opens
   * is wiped by the `term.reset()` that replays the attach snapshot. This
   * feature only ever fires at a terminal already on screen — which is why it
   * does not spawn one.
   */
  hasLiveTerminal: boolean;
}

/** Resolve an uploaded file to its absolute on-disk path. Returns `null` when
 *  the location can't be determined AND when the server reports the path
 *  doesn't actually exist on disk — pasting a path that `exists: false`
 *  reported would hand the agent a path that silently does not resolve,
 *  identical in effect to not having resolved it at all. */
async function resolvePath(fileId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/files/by-id/${fileId}/location`);
    if (!res.ok) return null;
    const { path, exists } = (await res.json()) as Partial<FileLocation>;
    if (!path || exists === false) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * The shell flavor the terminal PTY actually runs, from the server — never
 * from `getShellPlatform()`. That client-side sniff reads the BROWSER's user
 * agent, which is documented as cosmetic-only in `lib/shell/client.ts`
 * (decides a menu label, never behaviour), while the PTY is spawned
 * server-side by `lib/terminal/pty.ts#resolveShell`. Serving libi from one
 * machine (WSL, a devcontainer, a forwarded port) and opening it in a
 * browser on another makes those two disagree, and quoting for the wrong
 * shell can silently paste a path that does not exist. Returns `null` on any
 * failure — the caller must not guess.
 */
async function resolveShellFlavor(): Promise<ShellFlavor | null> {
  try {
    const res = await fetch("/api/terminal/shell-flavor");
    if (!res.ok) return null;
    const { flavor } = (await res.json()) as { flavor?: string };
    return flavor === "posix" || flavor === "powershell" ? flavor : null;
  } catch {
    return null;
  }
}

/**
 * Upload dropped files and paste their paths at the terminal's prompt.
 *
 * Files are uploaded one at a time so the pasted order matches the drop order.
 */
export function useTerminalFileDrop({ hasLiveTerminal }: Options) {
  const [isUploading, setIsUploading] = useState(false);

  const handleDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (!hasLiveTerminal) {
        toast.info("Open a terminal first, then drop the file on it.");
        return;
      }

      setIsUploading(true);
      const paths: string[] = [];
      try {
        for (const file of files) {
          try {
            // Dropping a file on the terminal shows the agent something; it
            // does not decide that the file belongs to the open piece. Upload
            // it UNASSIGNED and let the agent move it in with
            // libi.assign_file if it decides it does.
            const record = await uploadFileTo(null, file);
            const path = await resolvePath(record.id);
            if (path) paths.push(path);
            else toast.error(`${file.name}: couldn't resolve its path on disk`);
          } catch (err) {
            toast.error(
              `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`,
            );
          }
        }
      } finally {
        setIsUploading(false);
      }

      if (paths.length === 0) return;

      const flavor = await resolveShellFlavor();
      if (!flavor) {
        // Guessing wrong hands the agent a path that silently does not
        // exist (wrong quote-escaping for the shell actually listening) —
        // worse than inserting nothing.
        toast.error("Couldn't determine the terminal's shell — paste the path yourself.");
        return;
      }

      window.dispatchEvent(
        new CustomEvent(TERMINAL_INSERT_TEXT_EVENT, {
          detail: { text: buildInsertText(paths, flavor) },
        }),
      );
    },
    [hasLiveTerminal],
  );

  return { handleDrop, isUploading };
}
