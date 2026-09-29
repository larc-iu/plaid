import { useEffect, useRef } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from '@ui/components/ui/alert-dialog';

// The confirmation the screen asks before deleting the open entry. Whether it
// is open is the reducer's `dialog`.
export const EntryDialogs = ({
  dialog,
  dispatch,
  selectedItem,
  usageCounts,
  deleteRefPatches,
  deleteFreesSenses,
  // The entry's links changed while the dialog was open. Delete then keeps
  // it open, on the new count.
  deleteLinksChanged = false,
  // The count the server gave when it refused the delete for its count:
  // { total, hidden }, `hidden` the links in projects this person cannot
  // open. Null until then, when the count is the one this screen reads.
  deleteHidden = null,
  onConfirmDelete,
}) => {
  const close = () => dispatch({ type: 'dialog/close' });
  const open = dialog?.kind === 'delete';
  // The entry the question was last asked about. Delete closes the dialog
  // and the entry together, and a refusal opens the question again, so
  // while the dialog is closing and reopening it still names that entry.
  const askedRef = useRef(null);
  if (selectedItem) askedRef.current = selectedItem;
  const item = selectedItem ?? askedRef.current;
  const uses = deleteHidden ? deleteHidden.total : (usageCounts?.[item?.id] ?? 0);
  // Asked again on a new count, the question starts on Cancel, as when it
  // first opens. A refusal that comes back while the dialog is still closing
  // reopens the same content, which Radix does not focus again, so focus
  // would stay on Delete entry, where Enter was pressed.
  const cancelRef = useRef(null);
  useEffect(() => {
    if (open && (deleteHidden || deleteLinksChanged)) cancelRef.current?.focus();
  }, [open, deleteHidden, deleteLinksChanged]);
  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry?</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Warning</p>
                {deleteLinksChanged && (
                  <p className="mt-1 font-medium text-foreground">
                    Its links changed while this was open.
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  You are about to permanently delete the entry <strong>"{item?.form}"</strong>.
                </p>
                <p className="mt-1 text-muted-foreground">
                  {(usageCounts || deleteHidden) && uses > 0 ? (
                    <>
                      It is linked to{' '}
                      <strong>
                        {uses} word{uses === 1 ? '' : 's'}/morpheme{uses === 1 ? '' : 's'}
                      </strong>
                      {deleteHidden?.hidden
                        ? `, ${deleteHidden.hidden} of them in projects you cannot open`
                        : ''}
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
            <AlertDialogCancel ref={cancelRef} onClick={close}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirmDelete}
            >
              <Trash2 className="h-4 w-4" /> Delete entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
