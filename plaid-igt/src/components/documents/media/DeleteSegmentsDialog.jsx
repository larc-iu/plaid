import { useMemo, useState } from 'react';
import { ConfirmDeleteDialog } from '@/components/shared/ConfirmDeleteDialog';
import { Input } from '@/components/ui/input';
import { notifySuccess } from '@/utils/feedback';
import { segmentsWithText } from '@/domain/segments.js';

// Deleting segments in bulk: all of them, the ones with no text, or the ones
// whose text is a given value. The text stays in the baseline whichever is
// chosen. The count is shown as the choice changes, so what the button will
// do is never a surprise. Placeholders a person makes and never types into
// were the first request, from transcribing by ear.
const SCOPES = [
  ['empty', 'Segments with no text'],
  ['text', 'Segments whose text is'],
  ['all', 'All segments'],
];

export function DeleteSegmentsDialog({ open, onOpenChange, doc, alignmentTokens }) {
  const [scope, setScope] = useState('empty');
  const [value, setValue] = useState('');

  const targets = useMemo(() => {
    if (scope === 'all') return alignmentTokens;
    if (scope === 'empty') return segmentsWithText(alignmentTokens, doc.body, '');
    return value.trim() === '' ? [] : segmentsWithText(alignmentTokens, doc.body, value);
  }, [scope, value, alignmentTokens, doc.body]);
  const count = targets.length;
  const noun = count === 1 ? 'segment' : 'segments';

  const confirm = async () => {
    onOpenChange(false);
    const ok =
      scope === 'all'
        ? await doc.clearAlignments()
        : await doc.deleteAlignments(targets.map((t) => t.id));
    if (ok) notifySuccess(`Deleted ${count} ${noun}`, 'Segments deleted');
  };

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete segments"
      confirmLabel={count ? `Delete ${count} ${noun}` : 'Delete'}
      confirmDisabled={count === 0}
      onConfirm={confirm}
    >
      <div role="radiogroup" className="flex flex-col gap-2">
        {SCOPES.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="delete-segments-scope"
              value={key}
              checked={scope === key}
              onChange={() => setScope(key)}
            />
            <span className="shrink-0">{label}</span>
            {key === 'text' && (
              <Input
                aria-label="Segment text"
                value={value}
                onFocus={() => setScope('text')}
                onChange={(e) => setValue(e.target.value)}
                className="h-7 w-40"
              />
            )}
          </label>
        ))}
      </div>
      <p className="mt-2 text-muted-foreground">
        {count === 0
          ? 'No segments match.'
          : `${count} ${noun}. Times and speakers are removed. The text stays in the baseline.`}
      </p>
    </ConfirmDeleteDialog>
  );
}
