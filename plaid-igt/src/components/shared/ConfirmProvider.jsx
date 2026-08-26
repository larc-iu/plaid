import { createContext, useCallback, useContext, useRef, useState } from 'react';
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
} from '@/components/ui/alert-dialog';

// App-wide imperative confirmation modal. Replaces native window.confirm()
// so every "are you sure?" in the app uses one consistent shadcn AlertDialog
// (native confirm also blocks the renderer, which breaks automation + feels
// off-brand). Usage:
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title, description, confirmLabel, destructive }))) return;
//
// The promise resolves true on confirm, false on cancel / dismiss / Escape.

const ConfirmContext = createContext(null);

const EMPTY = {
  title: 'Are you sure?',
  description: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  destructive: false,
};

export function ConfirmProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(EMPTY);
  const resolverRef = useRef(null);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    if (resolve) resolve(result);
  }, []);

  const confirm = useCallback((options = {}) => {
    // A second confirm() while one is open cancels the first (last wins),
    // so we never strand a promise.
    if (resolverRef.current) resolverRef.current(false);
    setOpts({ ...EMPTY, ...options });
    setOpen(true);
    return new Promise((resolve) => { resolverRef.current = resolve; });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={(o) => { if (!o) settle(false); }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {opts.destructive && (
                <AlertTriangle className="mr-2 inline h-4 w-4 align-[-2px] text-destructive" />
              )}
              {opts.title}
            </AlertDialogTitle>
            {opts.description && (
              <AlertDialogDescription className="whitespace-pre-line">
                {opts.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {opts.cancelLabel}
            </AlertDialogCancel>
            <AlertDialogAction
              className={opts.destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined}
              onClick={() => settle(true)}
            >
              {opts.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

// Returns confirm(options) => Promise<boolean>. Outside a provider it falls
// back to a resolved-false promise (never throws), so a stray call can't crash.
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  return ctx || (() => Promise.resolve(false));
}
