"use client";

/**
 * Hand a `TerminalRemedy` to libi's OWN built-in Terminal.
 *
 * Extracted because three surfaces need it — the sidebar's "+" under
 * `needs-auth`, the empty session list, and the connect-tools section — and a
 * near-identical copy in each is how the three drift apart. (The first two
 * copies were written by separate workstreams that could not share a module
 * without crossing file ownership; this is that module.)
 *
 * Two deliberate behaviours, both load-bearing:
 *
 *   1. The SERVER NEVER RUNS THE COMMAND. Signing in is interactive — it opens
 *      a browser, prints a device code, waits on a paste. A server-side spawn
 *      would hang with nobody able to see or answer it, which is the same
 *      species of silent dead end this whole change exists to remove.
 *   2. THE TRAILING NEWLINE IS OMITTED. The command is pasted, not executed, so
 *      the user reads it before pressing Enter. libi is about to run a binary
 *      from inside its own node_modules; showing exactly what that is first is
 *      the honest thing to do.
 *
 * The command is handed to the terminal at SPAWN (`initialInput`), not
 * broadcast on `TERMINAL_INSERT_TEXT_EVENT` as the onboarding demo chip does.
 * The chip only ever fires at a terminal that is already on screen; this hook
 * creates the terminal in the same click, and every client-side delivery races
 * the mount, the socket, and the snapshot replay.
 */
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";

import { useEditorState } from "@/lib/editor-state-context";
import { useCreateTerminal } from "@/lib/queries/terminals";
import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";

export function useRunRemedyInTerminal(): (remedy: TerminalRemedy) => Promise<void> {
  const { selectAgent, setActiveTerminalId } = useEditorState();
  const createTerminal = useCreateTerminal();
  const pathname = usePathname();
  const router = useRouter();

  return async (remedy: TerminalRemedy) => {
    try {
      await selectAgent("terminal");

      // The command goes in at SPAWN, server-side, so it is already in the PTY
      // before any browser code attaches. Two client-side attempts failed here
      // and both failed for timing reasons: dispatching
      // TERMINAL_INSERT_TEXT_EVENT is heard by nobody (the view is a dynamic
      // import that has not mounted), and pasting once the socket opens is
      // wiped moments later by the `term.reset()` the client runs when it
      // replays the server's attach snapshot. Handing the text to the spawn
      // makes it part of that snapshot instead of a race against it.
      const meta = await createTerminal.mutateAsync({
        cliId: "shell",
        initialInput: remedy.command,
      });

      setActiveTerminalId(meta.id);
      if (pathname !== "/editor") router.push("/editor");
      toast.info(`Terminal opened — press Enter to run: ${remedy.command}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't open a terminal.",
      );
    }
  };
}
