import { Info } from 'lucide-react';
import { fullTimestamp } from '../../lib/formatTime.js';
import { changesMadeText } from '../../lib/auditText.js';
import { Notice } from './Notice.jsx';
import { SegmentedControl } from './SegmentedControl.jsx';

const VIEWS = [
  { value: 'changes', label: 'Changes' },
  { value: 'document', label: 'Document' },
];

// The line over a document shown at a past state. Keyed on the entry the reader
// ASKED for rather than on the snapshot on screen: the editor is read-only from
// the click, and this says so from the click.
//
// Where the app shows what an entry changed (`onView`), the line carries the
// switch between that and the document as of the entry, `view` being the one
// shown. An entry marked `action` is one change picked inside an entry.
//
// Both lines are plain information: one says what the page shows, the other
// that it is read-only. Neither is a fault, and the warm tones are for what is
// broken, never for "be advised".
export const HistoricalBanner = ({ entry, loading, view, onView, className = '' }) => {
  if (!entry) return null;
  const when = fullTimestamp(entry.time);
  const changes = onView && view === 'changes';
  const text = changes
    ? changesMadeText(entry)
    : loading
      ? `Loading the document as of ${when}…`
      : `Read-only. This is the document as of ${when}.`;
  return (
    <Notice tone="info" icon={Info} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{text}</span>
        {onView && <SegmentedControl label="View" value={view} onChange={onView} options={VIEWS} />}
      </div>
    </Notice>
  );
};
