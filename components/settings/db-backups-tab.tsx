"use client";

import { useEffect, useState } from "react";
import { DatabaseIcon, Trash2Icon, AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize } from "@/lib/utils/format";

interface BackupEntry {
  path: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export function DbBackupsTab() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function fetchBackups() {
    try {
      const res = await fetch("/api/db/backups");
      const data = await res.json();
      setBackups(data.backups ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBackups();
  }, []);

  async function handleDelete(filename: string) {
    setDeleting(filename);
    try {
      await fetch("/api/db/backups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      await fetchBackups();
    } finally {
      setDeleting(null);
    }
  }

  async function handleReset() {
    setResetting(true);
    setResetResult(null);
    try {
      const res = await fetch("/api/db/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "reset" }),
      });
      const data = await res.json();
      if (data.success) {
        setResetResult({ ok: true, message: "Database has been reset. Reloading..." });
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setResetResult({ ok: false, message: data.error || "Reset failed" });
      }
    } catch (err) {
      setResetResult({ ok: false, message: err instanceof Error ? err.message : "Reset failed" });
    } finally {
      setResetting(false);
    }
  }

  function formatDate(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  }

  return (
    <div className="space-y-6">
      {/* Backups list */}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      ) : backups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No database backups yet. Backups are created automatically before
          migrations.
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((b) => (
            <div
              key={b.filename}
              className="flex items-center gap-3 rounded-lg border bg-card p-3"
            >
              <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(b.createdAt)} &middot; {formatFileSize(b.sizeBytes)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="cursor-pointer"
                disabled={deleting === b.filename}
                onClick={() => handleDelete(b.filename)}
              >
                <Trash2Icon className="size-3.5" />
                <span className="sr-only">Delete backup</span>
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Danger zone */}
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-red-400" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-red-400">Reset Database</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Delete the database and start fresh. All pieces, sessions, settings,
              and MCP server configs will be permanently removed. A backup is
              saved automatically before the reset.
            </p>
            <Button
              variant="destructive"
              size="sm"
              className="mt-3 cursor-pointer"
              onClick={() => {
                setResetResult(null);
                setResetOpen(true);
              }}
            >
              Reset Database
            </Button>
          </div>
        </div>
      </div>

      {/* Reset confirmation dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Database?</DialogTitle>
            <DialogDescription>
              This will permanently delete all your data — pieces, sessions,
              settings, and MCP server configurations. A backup of the current
              database will be saved automatically. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {resetResult && (
            <p
              className={`rounded-md px-3 py-2 text-sm ${
                resetResult.ok
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-red-500/10 text-red-400"
              }`}
            >
              {resetResult.message}
            </p>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              disabled={resetting}
              onClick={() => setResetOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="cursor-pointer"
              disabled={resetting}
              onClick={handleReset}
            >
              {resetting && <LoaderIcon className="size-3.5 animate-spin" />}
              {resetting ? "Resetting..." : "Yes, Reset Everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
