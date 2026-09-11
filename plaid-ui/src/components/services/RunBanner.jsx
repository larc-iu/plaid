import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { formatElapsed } from '../../hooks/useRunProgress.js';

// Why the document has stopped accepting edits, and that the run behind it is
// still moving.
//
// This is the only surface that shows a run when the user has left the tab that
// mounts its button, or when the page was reloaded and the run was rejoined
// with no dialog open. So the clock ticks here in its own right: a run that
// reports nothing for a minute still visibly has a minute on it.
export function RunBanner({ label, startedAt, status, cancel }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <p className="font-medium">Editing paused</p>
        <span className="ml-auto text-xs tabular-nums">{formatElapsed(elapsedMs)}</span>
        {/* The only way to stop a run this page did not start: it lives in its
            own hook, so no tab's dialog has a handle on it. */}
        {cancel && (
          <Button variant="outline" size="sm" className="h-7" onClick={cancel}>
            Stop
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-xs" role="status">
        {label} is running.
        {status ? ` ${status}` : ''}
      </p>
    </div>
  );
}
