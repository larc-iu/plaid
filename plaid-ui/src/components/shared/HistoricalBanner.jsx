import { Info } from 'lucide-react';
import { fullTimestamp } from '../../lib/formatTime.js';

// The line over a document shown at a past state. Keyed on the entry the reader
// ASKED for rather than on the snapshot on screen: the editor is read-only from
// the click, and this says so from the click.
export const HistoricalBanner = ({ entry, loading, className = '' }) => {
  if (!entry) return null;
  const when = fullTimestamp(entry.time);
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 ${className}`}
    >
      {loading ? (
        <>
          <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-500/40 border-t-amber-700" />
          Loading the document as of {when}…
        </>
      ) : (
        <>
          <Info className="h-4 w-4 shrink-0" />
          Read-only. This is the document as of {when}.
        </>
      )}
    </div>
  );
};
