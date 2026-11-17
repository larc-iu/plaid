import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { sameNameIgnoringCase } from '@/domain/nameMatch';
import { RowControls } from '@/components/shared/RowControls';
import { useListManager } from './useListManager';
import { countOf } from '@ui/lib/plural.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { isEnter } from '@ui/lib/chords.js';

// The Baseline is first, and cannot be moved or removed. Its row is marked by
// `isBaseline`, never by its name: an orthography may be called Baseline too.
// It is drawn apart from the list, never as a row of it.
const DEFAULT_ORTHOGRAPHIES = [
  { name: 'Baseline', isBaseline: true },
  { name: 'IPA', isBaseline: false },
];

export const OrthographiesManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  // Async (name) => number|null of words with a non-empty value for this
  // orthography. When provided (settings mode), removal asks for confirmation
  // with the count; when absent (setup mode), removal is immediate.
  onCountOrthographyUsage,
  // A line under the list's description (setup's: every listed one is made).
  note,
  autoSaveDefaults = false, // Only auto-save defaults in setup mode
}) => {
  const {
    items: orthographies,
    isInitialized,
    save: saveChanges,
    move,
  } = useListManager({
    listKey: 'orthographies',
    noun: 'orthographies',
    defaults: () => DEFAULT_ORTHOGRAPHIES,
    initialData,
    onLoadData,
    onSaveChanges,
    onError,
    autoSaveDefaults,
  });
  const [newOrthographyName, setNewOrthographyName] = useState('');
  const nameId = useId();
  // { name, count } — count: undefined while counting, null if unknown.
  const [pendingDelete, setPendingDelete] = useState(null);

  const handleAddCustomOrthography = async () => {
    const trimmedName = newOrthographyName.trim();

    if (!trimmedName) {
      notifyError('Orthography name cannot be empty', 'Invalid orthography name');
      return;
    }

    if (orthographies.some((orth) => sameNameIgnoringCase(orth.name, trimmedName))) {
      notifyError('An orthography with this name already exists', 'Duplicate orthography');
      return;
    }

    if (!(await saveChanges([...orthographies, { name: trimmedName, isBaseline: false }]))) return;

    setNewOrthographyName('');
    notifySuccess(`Orthography “${trimmedName}” added`);
  };

  // Orthographies (never the Baseline row) are found by name: two cannot
  // share one.
  const handleDeleteOrthography = async (orthographyName) => {
    const saved = await saveChanges(
      orthographies.filter((orth) => orth.isBaseline || orth.name !== orthographyName),
    );
    if (!saved) return;

    notifyInfo(`Orthography “${orthographyName}” removed`);
  };

  // Entry point for the trash button: in settings mode open the confirm
  // dialog right away and fill in the usage count as it resolves.
  const requestDeleteOrthography = (orthographyName) => {
    if (!onCountOrthographyUsage) {
      handleDeleteOrthography(orthographyName);
      return;
    }
    setPendingDelete({ name: orthographyName, count: undefined });
    Promise.resolve(onCountOrthographyUsage(orthographyName))
      .then((n) =>
        setPendingDelete((p) =>
          p?.name === orthographyName ? { name: orthographyName, count: n } : p,
        ),
      )
      .catch(() =>
        setPendingDelete((p) =>
          p?.name === orthographyName ? { name: orthographyName, count: null } : p,
        ),
      );
  };

  const handleConfirmDelete = async () => {
    const orthographyName = pendingDelete?.name;
    setPendingDelete(null);
    if (orthographyName) await handleDeleteOrthography(orthographyName);
  };

  const handleKeyPress = (event) => {
    if (isEnter(event)) {
      handleAddCustomOrthography();
    }
  };

  const wouldBeDuplicate = () => {
    const trimmedName = newOrthographyName.trim();
    if (!trimmedName) return false;
    return orthographies.some((orth) => sameNameIgnoringCase(orth.name, trimmedName));
  };

  // The Baseline stays first: nothing moves into or out of index 0.
  const handleMoveOrthography = async (index, direction) => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (index <= 0 || newIndex <= 0) return;
    await move(index, newIndex);
  };

  if (!isInitialized) {
    return <Loading />;
  }

  // The Baseline row stays first in the list the parent saves, but it is not
  // an orthography a person adds: it is shown apart, as what it is, so that it
  // is never read as a slot for naming the text's own orthography.
  const additional = orthographies
    .map((orth, index) => ({ orth, index }))
    .filter(({ orth }) => !orth.isBaseline);

  return (
    <div className="flex flex-col gap-6">
      <div data-orth-block="baseline">
        <h2 className={TYPE.card}>Baseline</h2>
        <p className="mt-1 text-sm text-muted-foreground">The text as typed on the Baseline tab.</p>
      </div>

      <div data-orth-block="additional" className="flex flex-col gap-4">
        <div>
          <h2 className={TYPE.card}>Additional orthographies</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Other ways of writing the text (IPA, another script, a normalized form). Each is a
            separate row under every word in the Analyze grid, with its own value for each word,
            empty until filled in by hand or by a tool.
          </p>
          {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
        </div>

        {additional.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No additional orthographies.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {additional.map(({ orth, index }) => (
              <div
                key={`${orth.name}-${index}`}
                data-orth-row
                className="group flex items-center justify-between border-b px-3 py-2 last:border-b-0 hover:bg-muted/50"
              >
                <span className="text-sm">{orth.name}</span>
                <RowControls
                  name={orth.name}
                  onUp={() => handleMoveOrthography(index, 'up')}
                  onDown={() => handleMoveOrthography(index, 'down')}
                  canUp={index > 1}
                  canDown={index < orthographies.length - 1}
                  onRemove={() => requestDeleteOrthography(orth.name)}
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <div className="flex items-center gap-2">
            <Input
              id={nameId}
              value={newOrthographyName}
              onChange={(event) => setNewOrthographyName(event.target.value)}
              onKeyDown={handleKeyPress}
              className="flex-1"
            />
            <Button
              onClick={handleAddCustomOrthography}
              disabled={!newOrthographyName.trim() || wouldBeDuplicate()}
            >
              <Plus className="h-4 w-4" /> Add orthography
            </Button>
          </div>
        </div>
      </div>

      {/* Orthography-removal confirmation (settings mode only). Removing an
          orthography hides its column; the per-word values stay in token
          metadata and reappear if an orthography with the same name is
          re-added. */}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title={`Remove orthography “${pendingDelete?.name ?? ''}”?`}
        confirmLabel="Remove"
        confirmDisabled={pendingDelete?.count === undefined}
        onConfirm={handleConfirmDelete}
      >
        <p>
          {pendingDelete?.count === undefined && 'Counting existing transcriptions…'}
          {pendingDelete?.count === null &&
            'The number of existing transcriptions could not be determined.'}
          {typeof pendingDelete?.count === 'number' &&
            (pendingDelete.count === 0 ? (
              'No words have a transcription in this orthography yet.'
            ) : (
              <>
                <strong>{countOf(pendingDelete.count, 'word')}</strong> currently{' '}
                {pendingDelete.count === 1 ? 'has' : 'have'} a transcription in this orthography.
              </>
            ))}
        </p>
        <p>
          Existing values are hidden, not deleted. Re-adding an orthography with the same name
          restores them.
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};
