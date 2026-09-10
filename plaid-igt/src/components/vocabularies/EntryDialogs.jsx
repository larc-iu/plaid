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

// The two confirmations the screen asks: deleting the open entry, and leaving
// a draft with unsaved edits. Which one is open is the reducer's `dialog`;
// `onDiscard(target)` is the navigation a confirmed discard performs.
export const EntryDialogs = ({
  dialog,
  dispatch,
  selectedItem,
  draftForm,
  usageCounts,
  deleteRefPatches,
  deleteFreesSenses,
  onConfirmDelete,
  onDiscard,
}) => {
  const close = () => dispatch({ type: 'dialog/close' });
  const uses = usageCounts?.[selectedItem?.id] ?? 0;
  return (
    <>
      <AlertDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Warning</p>
                <p className="mt-1 text-muted-foreground">
                  You are about to permanently delete the entry{' '}
                  <strong>"{selectedItem?.form}"</strong>.
                </p>
                <p className="mt-1 text-muted-foreground">
                  {usageCounts && uses > 0 ? (
                    <>
                      It is linked to{' '}
                      <strong>
                        {uses} word{uses === 1 ? '' : 's'}/morpheme{uses === 1 ? '' : 's'}
                      </strong>
                      . Those links will be removed.{' '}
                    </>
                  ) : null}
                  {deleteRefPatches.length > 0 && (
                    <>
                      <strong>
                        {deleteRefPatches.length} entr
                        {deleteRefPatches.length === 1 ? 'y' : 'ies'}
                      </strong>{' '}
                      {deleteRefPatches.length === 1 ? 'refers' : 'refer'} to it.{' '}
                      {deleteFreesSenses
                        ? 'Its senses become entries of their own, and those '
                        : 'Those '}
                      references are removed.{' '}
                    </>
                  )}
                  This action cannot be undone.
                </p>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirmDelete}
            >
              <Trash2 className="h-4 w-4" /> Delete entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dialog?.kind === 'discard'}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved edits to <strong>"{draftForm || selectedItem?.form}"</strong>.
            Switching away will discard them.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onDiscard(dialog?.target ?? null);
                close();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
