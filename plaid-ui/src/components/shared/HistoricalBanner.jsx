import { Info } from 'lucide-react';
import { fullTimestamp } from '../../lib/formatTime.js';
import { Notice } from './Notice.jsx';

// The line over a document shown at a past state. Keyed on the entry the reader
// ASKED for rather than on the snapshot on screen: the editor is read-only from
// the click, and this says so from the click.
export const HistoricalBanner = ({ entry, loading, className = '' }) => {
  if (!entry) return null;
  const when = fullTimestamp(entry.time);
  return (
    <Notice tone="warning" icon={Info} className={className}>
      {loading
        ? `Loading the document as of ${when}…`
        : `Read-only. This is the document as of ${when}.`}
    </Notice>
  );
};
