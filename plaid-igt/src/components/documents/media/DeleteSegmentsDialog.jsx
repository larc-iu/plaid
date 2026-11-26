import { useMemo, useState } from 'react';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Input } from '@ui/components/ui/input';
import { notifySuccess } from '@/utils/feedback';
import { segmentsWithText } from '@/domain/segments.js';
import { msg, t } from '@ui/lib/i18n.js';

// Deleting segments in bulk: all of them, the ones with no text, or the ones
// whose text is a given value. The baseline text is left alone whichever is
// chosen. The count is shown as the choice changes, so what the button will
// do is never a surprise. Placeholders a person makes and never types into
// were the first request, from transcribing by ear.
const SCOPES = [
  ['empty', msg('Segments with no text')],
  ['text', msg('Segments whose text is')],
  ['all', msg('All segments')],
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

  const confirm = async () => {
    onOpenChange(false);
    const ok =
      scope === 'all'
        ? await doc.clearAlignments()
        : await doc.deleteAlignments(targets.map((t) => t.id));
    if (ok)
      notifySuccess(
        t('{n, plural, one {Deleted {n} segment} other {Deleted {n} segments}}', { n: count }),
        t('Segments deleted'),
      );
  };

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Delete segments?')}
      confirmLabel={
        count
          ? t('{n, plural, one {Delete {n} segment} other {Delete {n} segments}}', { n: count })
          : t('Delete')
      }
      confirmDisabled={count === 0}
      onConfirm={confirm}
      description={
        count === 0
          ? t('No segments match.')
          : t(
              '{n, plural, one {{n} segment} other {{n} segments}}. Times and speakers are removed. The baseline text is unchanged.',
              { n: count },
            )
      }
    >
      <div role="radiogroup" className="flex flex-col gap-2 text-foreground">
        {SCOPES.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="delete-segments-scope"
              value={key}
              checked={scope === key}
              onChange={() => setScope(key)}
            />
            <span className="shrink-0">{t(label)}</span>
            {key === 'text' && (
              <Input
                aria-label={t('Segment text')}
                value={value}
                onFocus={() => setScope('text')}
                onChange={(e) => setValue(e.target.value)}
                className="h-7 w-40"
              />
            )}
          </label>
        ))}
      </div>
    </ConfirmDeleteDialog>
  );
}
