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

/**
 * "Delete <name>?" — the one confirmation a template's card and its page both
 * ask. `published`: the user's own template has a public copy, which deleting
 * the local one leaves in the catalog, so the dialog says where to take it down.
 */
export function DeleteTemplateDialog({
  name,
  published,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  published: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;<bdi>{name}</bdi>&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The template and its files are removed from this machine. Pieces made from it are not affected.
            {published && (
              <>
                {" "}
                <span data-testid="template-delete-published-note">
                  Its public copy stays in the catalog: to take it down, use Hide first — or, once this copy is gone,
                  hide it under &ldquo;Your templates&rdquo; in List view.
                </span>
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="template-delete-confirm"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
              onOpenChange(false);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
