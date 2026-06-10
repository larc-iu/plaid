import { AlertTriangle, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

// Confirmation dialog for destructive deletions. `children` is the warning
// body — it may re-render while the dialog is open (e.g. as a usage count
// resolves). The caller owns open state and performs the deletion in
// `onConfirm`.
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  confirmLabel = 'Delete',
  confirmDisabled = false,
  onConfirm,
  children,
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>

        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">{children}</div>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            <Trash2 className="h-4 w-4" /> {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
