import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../ui/alert-dialog.jsx';
import { CONFIRM_DELETE_CLASS } from '../../lib/destructive.js';

/**
 * The "are you sure" before a delete or a clear, for a body that is more than
 * one fixed line: a count that resolves while the dialog is open, a choice, a
 * field to type in. It looks exactly like `useConfirm({ destructive: true })`:
 * a red triangle in the title, the body in muted text, a solid red button with
 * a short verb.
 *
 * Props:
 * - `open`, `onOpenChange`: the caller owns the open state.
 * - `title`, `confirmLabel` (default "Delete"): the button's verb.
 * - `confirmDisabled`: the button waits (a count still loading, a name not yet
 *   typed).
 * - `busy`: the work is running. Both buttons are disabled.
 * - `onConfirm(event)`: runs the deletion. The dialog closes on the click
 *   unless the handler calls `event.preventDefault()`, which a caller that
 *   shows its own progress inside the dialog does.
 * - `children`: the body, re-rendered live.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  confirmLabel = 'Delete',
  confirmDisabled = false,
  busy = false,
  onConfirm,
  children,
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <AlertTriangle
              aria-hidden="true"
              className="mr-2 inline h-4 w-4 align-[-2px] text-destructive"
            />
            {title}
          </AlertDialogTitle>
          {children != null && (
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">{children}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={CONFIRM_DELETE_CLASS}
            disabled={confirmDisabled || busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
