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
import { FormLabel } from './FormLabel';
import { t, tx } from '@ui/lib/i18n.js';

const strong = (c) => <strong>{c}</strong>;

// The confirmation the screen asks before deleting the open entry. Whether it
// is open is the reducer's `dialog`.
export const EntryDialogs = ({
  dialog,
  dispatch,
  selectedItem,
  // buildItemNumbers, so the entry is named as the list names it.
  numbers,
  usageCounts,
  deleteRefPatches,
  deleteFreesSenses,
  // The entry's links changed while the dialog was open. Delete then keeps
  // it open, on the new count.
  deleteLinksChanged = false,
  // More entries refer to it than the dialog said when it opened (another
  // person added a sense under it or pointed a field at it). Delete then
  // keeps it open, on the new count.
  deleteRefsChanged = false,
  // The count the server gave when it refused the delete for its count:
  // { total, hidden }, `hidden` the links in projects this person cannot
  // open. Null until then, when the count is the one this screen reads.
  deleteHidden = null,
  // Some of its links are in projects this person cannot write, where a
  // morpheme that took its type from the entry is left with none.
  deleteTypesLost = false,
  onConfirmDelete,
  // Where focus goes on close when what opened the dialog is gone (a delete
  // closes the entry under it). Returns whether it found a place.
  focusAfterClose,
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
    if (open && (deleteHidden || deleteLinksChanged || deleteRefsChanged)) {
      cancelRef.current?.focus();
    }
  }, [open, deleteHidden, deleteLinksChanged, deleteRefsChanged]);
  // What had focus when the dialog opened. A refusal reopens the question
  // after the Delete button that opened it went with the entry, and Radix
  // would put focus back on that detached button, which is the body.
  const openerRef = useRef(null);
  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <AlertDialogContent
          className="max-w-md"
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement;
          }}
          onCloseAutoFocus={(e) => {
            if (openerRef.current?.isConnected) return;
            if (focusAfterClose?.()) e.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete entry?')}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">{t('Warning')}</p>
                {deleteLinksChanged && (
                  <p className="mt-1 font-medium text-foreground">
                    {t('Its links changed while this was open.')}
                  </p>
                )}
                {deleteRefsChanged && (
                  <p className="mt-1 font-medium text-foreground">
                    {t('The entries that refer to it changed while this was open.')}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  {tx('Deletes the entry <strong>"{form}"</strong>.', {
                    form: (
                      <FormLabel
                        key="form"
                        form={item?.form ?? ''}
                        index={numbers?.get(item?.id)}
                      />
                    ),
                    strong,
                  })}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {(usageCounts || deleteHidden) && uses > 0 ? (
                    <>
                      {deleteHidden?.hidden
                        ? tx(
                            'It is linked to <strong>{n, plural, one {# word/morpheme} other {# words/morphemes}}</strong>, {hidden} of them in projects you cannot open. Those links will be removed.',
                            { n: uses, hidden: deleteHidden.hidden, strong },
                          )
                        : tx(
                            'It is linked to <strong>{n, plural, one {# word/morpheme} other {# words/morphemes}}</strong>. Those links will be removed.',
                            { n: uses, strong },
                          )}{' '}
                      {deleteTypesLost
                        ? `${t('Morphemes in projects you cannot write that took their type from it will have none.')} `
                        : ''}
                    </>
                  ) : null}
                  {deleteRefPatches.length > 0 && (
                    <>
                      {deleteFreesSenses
                        ? tx(
                            '<strong>{n, plural, one {# entry} other {# entries}}</strong> {n, plural, one {refers} other {refer}} to it. Its senses become entries of their own, and those references are removed.',
                            { n: deleteRefPatches.length, strong },
                          )
                        : tx(
                            '<strong>{n, plural, one {# entry} other {# entries}}</strong> {n, plural, one {refers} other {refer}} to it. Those references are removed.',
                            { n: deleteRefPatches.length, strong },
                          )}{' '}
                    </>
                  )}
                  {t("It can be undone from the vocabulary's History.")}
                </p>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} onClick={close}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirmDelete}
            >
              <Trash2 className="h-4 w-4" /> {t('Delete entry')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
