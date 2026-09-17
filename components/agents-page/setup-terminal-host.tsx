"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { SetupSurface } from "@/lib/terminal/types";
import { closeSetupTerminalOnLeave, useCloseSetupTerminal, useOpenSetupTerminal } from "@/lib/queries/setup-terminals";
import { trackEvent } from "@/lib/analytics/client";

export type SetupAction =
  | "install"
  | "sign-in"
  | "connect-libi"
  | "disconnect-libi"
  | "reconnect-libi"
  | "provider-add"
  | "provider-replace"
  | "provider-remove"
  | "provider-sign-in";

export interface SetupTerminalEntry {
  id: string;
  action: SetupAction;
  command: string;
  /** The shell exited while a view was attached to it. */
  exited: boolean;
  exitCode: number | null;
  /**
   * The server no longer has this terminal: it was closed while no view was
   * attached (usually the idle reaper, after its tab was left for a while).
   * It cannot be re-attached; running the step again opens a new one.
   */
  gone: boolean;
  /**
   * Where on its surface the terminal is shown, as the opener named it. The
   * Providers tab shows its one terminal inside the row whose action opened
   * it, and a tab switch unmounts the tab while the terminal lives on here —
   * so the place is kept with the terminal, not in the tab.
   */
  anchor?: string;
  /** What the waiting command does, in a sentence or two, from the opener. */
  explanation?: string;
  /** The scripts the waiting command runs, each with a link that opens its text to read. */
  scripts?: SetupScriptLink[];
}

export interface SetupScriptLink {
  /** The script's file name, e.g. `add-provider.sh`. */
  name: string;
  url: string;
}

type SetupTerminals = Partial<Record<SetupSurface, SetupTerminalEntry>>;

export interface SetupTerminalHostValue {
  terminals: SetupTerminals;
  open: (
    surface: SetupSurface,
    command: string,
    action: SetupAction,
    anchor?: string,
    explanation?: string,
    scripts?: SetupScriptLink[],
  ) => Promise<SetupTerminalEntry>;
  close: (surface: SetupSurface) => Promise<void>;
  /** Ignored unless `terminalId` is still the surface's terminal. */
  markExited: (surface: SetupSurface, terminalId: string, exitCode: number) => void;
  /** Ignored unless `terminalId` is still the surface's terminal. */
  markGone: (surface: SetupSurface, terminalId: string) => void;
}

const Ctx = createContext<SetupTerminalHostValue | null>(null);

/**
 * Owns one setup terminal per surface for the whole `/agents` page. A tab
 * switch unmounts the tab's panel, not this host, so the terminal (and the
 * command waiting in it) survives and is re-shown when the tab comes back;
 * leaving the page deletes them all.
 */
export function SetupTerminalHost({ children }: { children: React.ReactNode }) {
  const [terminals, setTerminals] = useState<SetupTerminals>({});
  // Always the newest map. Written only by `update`, which sets the state from
  // the same value, so a callback never acts on a map older than the screen.
  const terminalsRef = useRef<SetupTerminals>({});
  const mountedRef = useRef(false);
  // Per surface: the number of the newest open() call, and the tail of that
  // surface's queue of open() requests.
  const openCountRef = useRef(0);
  const newestOpenRef = useRef<Partial<Record<SetupSurface, number>>>({});
  const openQueueRef = useRef<Partial<Record<SetupSurface, Promise<unknown>>>>({});
  const { mutateAsync: openTerminal } = useOpenSetupTerminal();
  const { mutateAsync: closeTerminal } = useCloseSetupTerminal();

  const update = useCallback((change: (prev: SetupTerminals) => SetupTerminals) => {
    const next = change(terminalsRef.current);
    if (next === terminalsRef.current) return;
    terminalsRef.current = next;
    setTerminals(next);
  }, []);

  /** Patch a surface's entry, but only while it is still terminal `terminalId`. */
  const patchEntry = useCallback(
    (surface: SetupSurface, terminalId: string, patch: Partial<SetupTerminalEntry>) => {
      update((prev) => {
        const entry = prev[surface];
        return entry?.id === terminalId ? { ...prev, [surface]: { ...entry, ...patch } } : prev;
      });
    },
    [update],
  );

  const open = useCallback<SetupTerminalHostValue["open"]>(
    async (surface, command, action, anchor, explanation, scripts) => {
      const openNumber = ++openCountRef.current;
      newestOpenRef.current[surface] = openNumber;
      // A surface's requests go out one at a time, in call order. Creating a
      // setup terminal closes the surface's previous one on the server, so
      // this keeps the server's live terminal and the newest call the same.
      // Each request is bounded (`OPEN_SETUP_TERMINAL_TIMEOUT_MS`): one that
      // never answers fails like a refused spawn, and the queue moves on.
      const request = (openQueueRef.current[surface] ?? Promise.resolve()).then(() =>
        openTerminal({ surface, command }),
      );
      openQueueRef.current[surface] = request.catch(() => undefined);

      let entry: SetupTerminalEntry;
      try {
        const meta = await request;
        entry = {
          id: meta.id,
          action,
          command,
          exited: false,
          exitCode: null,
          gone: false,
          ...(anchor === undefined ? {} : { anchor }),
          ...(explanation === undefined ? {} : { explanation }),
          ...(scripts === undefined ? {} : { scripts }),
        };
      } catch (err) {
        // A refused spawn (at the session cap, or a bad surface) must be
        // visible rather than an unhandled rejection. Callers still get the
        // rejection so they can reset their own pending state.
        toast.error(err instanceof Error ? err.message : "Couldn't open a terminal");
        throw err;
      }
      // Nobody will ever see this terminal — the page was left while the
      // request was in flight, or a newer open() on the same surface has
      // superseded it — so delete it now instead of waiting for the reaper.
      if (!mountedRef.current || newestOpenRef.current[surface] !== openNumber) {
        closeSetupTerminalOnLeave(entry.id);
        return entry;
      }
      update((prev) => ({ ...prev, [surface]: entry }));
      // Counted once the terminal EXISTS, never on the click — a refused spawn reports nothing.
      trackEvent("setup_terminal_opened", { surface, action });
      return entry;
    },
    [openTerminal, update],
  );

  const close = useCallback<SetupTerminalHostValue["close"]>(
    async (surface) => {
      const entry = terminalsRef.current[surface];
      if (!entry) return;
      // Removed before the DELETE is awaited, and only while it is still this
      // terminal, so a slow DELETE never takes a newer terminal with it.
      update((prev) => {
        if (prev[surface]?.id !== entry.id) return prev;
        const rest = { ...prev };
        delete rest[surface];
        return rest;
      });
      await closeTerminal(entry.id).catch(() => undefined);
    },
    [closeTerminal, update],
  );

  const markExited = useCallback<SetupTerminalHostValue["markExited"]>(
    (surface, terminalId, exitCode) => patchEntry(surface, terminalId, { exited: true, exitCode }),
    [patchEntry],
  );

  const markGone = useCallback<SetupTerminalHostValue["markGone"]>(
    (surface, terminalId) => patchEntry(surface, terminalId, { gone: true }),
    [patchEntry],
  );

  // Leaving /agents (unmount) and leaving the page entirely (pagehide) both
  // delete every live setup terminal; the server's idle reaper is the backstop.
  useEffect(() => {
    mountedRef.current = true;
    const closeAll = () => {
      for (const entry of Object.values(terminalsRef.current)) if (entry) closeSetupTerminalOnLeave(entry.id);
    };
    window.addEventListener("pagehide", closeAll);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", closeAll);
      closeAll();
    };
  }, []);

  const value = useMemo(
    () => ({ terminals, open, close, markExited, markGone }),
    [terminals, open, close, markExited, markGone],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSetupTerminalHost(): SetupTerminalHostValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSetupTerminalHost must be used inside <SetupTerminalHost>");
  return v;
}
