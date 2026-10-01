"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ExportRecordView } from "@/lib/exports/types";

/** "Delete this export? The file is removed from libi." — open while `exp` is set. */
export function ExportDeleteDialog({
  exp,
  onConfirm,
  onCancel,
}: {
  exp: ExportRecordView | null;
  onConfirm: (e: ExportRecordView) => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={exp !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this export?</AlertDialogTitle>
          <AlertDialogDescription>
            The file is removed from libi.{exp ? ` (${exp.fileName ?? exp.name})` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
          <AlertDialogAction className="cursor-pointer" onClick={() => exp && onConfirm(exp)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
