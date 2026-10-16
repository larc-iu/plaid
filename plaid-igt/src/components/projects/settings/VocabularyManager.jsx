import { useState, useEffect, useRef } from 'react';
import { Plus, Unlink } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { SearchInput, ListCount, ListPager } from '@ui/components/shared/list-search';
import { usePagedList } from '@ui/hooks/usePagedList';
import { Button } from '@ui/components/ui/button';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { cn } from '@ui/lib/utils';
import { notifyError } from '@/utils/feedback';
import { textIncludes } from '@ui/domain/collation.js';
import { loadEntryCounts } from '@/domain/vocabEntryCounts.js';
import { countOf } from '@ui/lib/plural.js';
import { sameNameIgnoringCase } from '@/domain/nameMatch';
import { RowControls } from '@/components/shared/RowControls';

// A row the user may not link: an unlinked vocabulary whose row says so
// (`canLink: false`, set by the screen that loaded it). A linked row is always
// free to unlink, and once unlinked it locks again.
const isLocked = (vocab) => !vocab.enabled && vocab.canLink === false;

// A temporary id for a vocabulary the wizard will create.
const customVocabId = () => `new-${Date.now()}`;

export const VocabularyManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true,
  isSettings = false,
  client = null, // reads each vocabulary's entry count, when given
  onCountLinks = null, // how many links this project has into a vocabulary
}) => {
  const [vocabularies, setVocabularies] = useState([]);
  const [newVocabName, setNewVocabName] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [unlinkModalOpened, setUnlinkModalOpened] = useState(false);
  const [vocabToUnlink, setVocabToUnlink] = useState(null);
  // The links an unlink removes: undefined while counted, null if unreadable.
  const [unlinkCount, setUnlinkCount] = useState(undefined);
  // The row the count is for, so a late answer for another row is dropped.
  const unlinkAsked = useRef(null);
  // vocabId -> entry count. Two vocabularies may share a name, and the count
  // is what tells them apart on screen. Absent while loading or if unreadable.
  const [entryCounts, setEntryCounts] = useState({});

  // Sends wait their turn, so two quick ticks reach the server in order.
  const sends = useRef(Promise.resolve());

  const openUnlinkModal = () => setUnlinkModalOpened(true);
  const closeUnlinkModal = () => setUnlinkModalOpened(false);

  useEffect(() => {
    const initializeData = async () => {
      try {
        setLoading(true);
        let vocabData = initialData;

        if ((!vocabData || !vocabData.vocabularies) && onLoadData) {
          vocabData = await onLoadData();
        }

        if (!vocabData?.vocabularies) {
          vocabData = { vocabularies: [] };
        }

        setVocabularies(vocabData.vocabularies);
        setIsInitialized(true);
        setError('');
      } catch (err) {
        console.error('Failed to load vocabularies configuration:', err);
        setError('Failed to load the vocabularies.');
        setVocabularies([]);
        setIsInitialized(true);

        if (onError) {
          onError(err);
        } else {
          notifyError(err, 'Failed to load the vocabularies');
        }
      } finally {
        setLoading(false);
      }
    };

    initializeData();
    // Runs once per initialData; the callbacks are read fresh and must not
    // start another load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData]);

  // One read per list, once it has loaded. A row added in the wizard is not on
  // the server yet and has no count.
  const serverIds = isInitialized
    ? vocabularies
        .filter((v) => !v.isCustom)
        .map((v) => v.id)
        .sort()
        .join(' ')
    : '';
  useEffect(() => {
    if (!client || !serverIds) return;
    let cancelled = false;
    loadEntryCounts(client, serverIds.split(' '))
      .then((counts) => {
        if (!cancelled) setEntryCounts(counts);
      })
      .catch((err) => console.error('Failed to count vocabulary entries:', err));
    return () => {
      cancelled = true;
    };
  }, [client, serverIds]);

  // Every change shows at once and is sent after the one before it. `change`
  // names the one row a link or unlink touched: a refused send puts that row
  // back, unless it has been changed again since, and leaves every other row
  // as it is.
  const saveChanges = (newVocabularies, change = null) => {
    setVocabularies(newVocabularies);
    if (!onSaveChanges) return;
    sends.current = sends.current
      .then(() => onSaveChanges({ vocabularies: newVocabularies, change }))
      .catch((error) => {
        console.error('Failed to save vocabularies configuration:', error);
        if (change) {
          setVocabularies((current) =>
            current.map((vocab) =>
              vocab.id === change.id && vocab.enabled === change.enabled
                ? { ...vocab, enabled: !change.enabled }
                : vocab,
            ),
          );
        }
        if (onError) {
          onError(error);
        } else {
          notifyError(error, 'Failed to save the vocabularies');
        }
      });
  };

  const handleVocabToggle = (vocabId, enabled) => {
    const row = vocabularies.find((v) => v.id === vocabId);
    if (enabled && row && isLocked(row)) return;
    // In settings an unlink asks first.
    if (isSettings && !enabled) {
      const vocab = vocabularies.find((v) => v.id === vocabId);
      if (vocab) {
        setVocabToUnlink(vocab);
        setUnlinkCount(onCountLinks ? undefined : null);
        openUnlinkModal();
        if (onCountLinks) {
          unlinkAsked.current = vocab;
          Promise.resolve(onCountLinks(vocab))
            .catch(() => null)
            .then((n) => {
              if (unlinkAsked.current === vocab) setUnlinkCount(typeof n === 'number' ? n : null);
            });
        }
        return;
      }
    }

    const updatedVocabs = vocabularies.map((vocab) =>
      vocab.id === vocabId ? { ...vocab, enabled } : vocab,
    );
    saveChanges(updatedVocabs, { id: vocabId, enabled });
  };

  const handleConfirmUnlink = () => {
    if (!vocabToUnlink) return;
    const { id } = vocabToUnlink;
    // The name stays set while the dialog animates out, or its title reads
    // "Unlink vocabulary “”?" for the length of the fade. The next open
    // replaces it.
    closeUnlinkModal();
    const updatedVocabs = vocabularies.map((vocab) =>
      vocab.id === id ? { ...vocab, enabled: false } : vocab,
    );
    saveChanges(updatedVocabs, { id, enabled: false });
  };

  const handleAddCustomVocab = async () => {
    const trimmedName = newVocabName.trim();

    if (!trimmedName) {
      notifyError('Vocabulary name cannot be empty', 'Invalid vocabulary name');
      return;
    }

    if (vocabularies.some((vocab) => sameNameIgnoringCase(vocab.name, trimmedName))) {
      notifyError('A vocabulary with this name already exists', 'Duplicate vocabulary');
      return;
    }

    const newVocab = {
      name: trimmedName,
      id: customVocabId(),
      enabled: true,
      isCustom: true,
    };

    const updatedVocabs = [...vocabularies, newVocab];
    saveChanges(updatedVocabs);

    setNewVocabName('');
    // No toast. The row appearing IS the confirmation, and a failure raises
    // its own error. In the setup wizard this toast also landed bottom-right on
    // top of the step's own Next button and swallowed the click on it.
  };

  const handleDeleteCustomVocab = async (vocabId) => {
    const updatedVocabs = vocabularies.filter((vocab) => vocab.id !== vocabId);
    saveChanges(updatedVocabs);
    // Likewise: the row is gone, which is the whole message.
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomVocab();
    }
  };

  const wouldBeDuplicate = () => {
    const trimmedName = newVocabName.trim();
    if (!trimmedName) return false;
    return vocabularies.some((vocab) => sameNameIgnoringCase(vocab.name, trimmedName));
  };

  // What the arrows order is the LINKED vocabularies among themselves, since
  // those are the only rows that carry them, so a move swaps a row with the
  // next linked row wherever that sits rather than with whatever happens to be
  // next in the whole list. That also makes the arrows independent of the
  // search and the page: they used to step through the full array, which on
  // page 2 of a searched list would have moved a row past neighbours nobody
  // could see.
  const linkedNeighbour = (vocabId, direction) => {
    const at = vocabularies.findIndex((v) => v.id === vocabId);
    if (at === -1) return -1;
    const step = direction === 'up' ? -1 : 1;
    for (let i = at + step; i >= 0 && i < vocabularies.length; i += step) {
      if (vocabularies[i].enabled) return i;
    }
    return -1;
  };

  const handleMoveVocab = async (vocabId, direction) => {
    const currentIndex = vocabularies.findIndex((vocab) => vocab.id === vocabId);
    const newIndex = linkedNeighbour(vocabId, direction);
    if (currentIndex === -1 || newIndex === -1) return;

    const newVocabs = [...vocabularies];
    [newVocabs[currentIndex], newVocabs[newIndex]] = [newVocabs[newIndex], newVocabs[currentIndex]];

    saveChanges(newVocabs);
  };

  // The table's rows, ABOVE the early returns below: `usePagedList` is a hook,
  // so it cannot sit behind a loading branch.
  const tableData = vocabularies.map((vocab, index) => ({
    ...vocab,
    tableId: `${vocab.name}-${index}`,
  }));
  // Searched and paged, as every other browsable list in the app is. Every
  // vocabulary on the server lands here, and on a shared server that is a
  // hundred rows, dozens of them named "Lexicon", with the Add field and the
  // wizard's Next button below all of it. Picking a colleague's lexicon out of
  // that was not realistically possible.
  const q = query.trim().toLowerCase();
  const shown = q ? tableData.filter((v) => textIncludes(v.name || '', q)) : tableData;
  const paged = usePagedList(shown, { resetKey: q });

  if (!isInitialized || loading) {
    return <Loading />;
  }

  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Vocabularies Table */}
      <div>
        {showTitle && <p className="mb-4 text-sm font-medium">Vocabularies</p>}

        <div className="mb-2 flex flex-wrap items-center gap-3">
          <SearchInput
            className="min-w-56 flex-1"
            placeholder="Search vocabularies…"
            value={query}
            onChange={setQuery}
          />
          <ListCount shown={shown.length} total={tableData.length} noun="vocabulary" />
        </div>

        <div className="overflow-hidden rounded-md border">
          <ListPager {...paged} />
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="w-[10%] px-3 py-2 text-left font-medium">Link</th>
                <th className="px-3 py-2 text-left font-medium">Vocabulary name</th>
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((record) => (
                <tr
                  key={record.tableId}
                  className={cn(
                    'border-t',
                    isLocked(record) ? 'cursor-default' : 'cursor-pointer hover:bg-muted/50',
                  )}
                  onClick={() => handleVocabToggle(record.id, !record.enabled)}
                >
                  <td className="px-3 py-2">
                    {/* A checkbox, not a tick-or-cross glyph. A glyph reads as
                        a status and not a control, so the first thing anyone
                        did was click it to find out, with the whole row as the
                        hit target and the only feedback a mark changing shape
                        at the far left. The row still toggles. */}
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-default"
                      checked={record.enabled}
                      disabled={isLocked(record)}
                      aria-label={`${record.enabled ? 'Unlink' : 'Link'} ${record.name}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => handleVocabToggle(record.id, event.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn(record.enabled ? '' : 'italic text-muted-foreground')}>
                        <span dir="auto">{record.name}</span>
                        {entryCounts[record.id] !== undefined && (
                          <span className="ml-2 text-xs not-italic text-muted-foreground">
                            {countOf(entryCounts[record.id], 'entry', 'entries')}
                          </span>
                        )}
                        {isLocked(record) && (
                          <span className="block text-xs not-italic text-muted-foreground">
                            Only its maintainers can link it.
                          </span>
                        )}
                      </span>
                      {/* Setup orders the linked vocabularies and removes the
                          ones it made. Settings unlinks. */}
                      {isSettings ? (
                        record.enabled && (
                          <RowControls
                            name={record.name}
                            onRemove={() => handleVocabToggle(record.id, false)}
                            removeLabel="Unlink"
                            removeIcon={Unlink}
                          />
                        )
                      ) : (
                        <RowControls
                          name={record.name}
                          {...(record.enabled && {
                            onUp: () => handleMoveVocab(record.id, 'up'),
                            onDown: () => handleMoveVocab(record.id, 'down'),
                            canUp: linkedNeighbour(record.id, 'up') !== -1,
                            canDown: linkedNeighbour(record.id, 'down') !== -1,
                          })}
                          {...(record.isCustom && {
                            onRemove: () => handleDeleteCustomVocab(record.id),
                          })}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager {...paged} />
        </div>

        {!isSettings && (
          <div className="mt-4">
            <p className="mb-4 text-sm font-medium">New vocabulary</p>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Enter vocabulary name"
                value={newVocabName}
                onChange={(event) => setNewVocabName(event.target.value)}
                onKeyDown={handleKeyPress}
                className="flex-1"
              />
              <Button
                onClick={handleAddCustomVocab}
                disabled={!newVocabName.trim() || wouldBeDuplicate()}
              >
                <Plus className="h-4 w-4" /> Add vocabulary
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDeleteDialog
        open={unlinkModalOpened}
        onOpenChange={(o) => {
          if (!o) closeUnlinkModal();
        }}
        title={`Unlink vocabulary “${vocabToUnlink?.name ?? ''}”?`}
        confirmLabel="Unlink"
        confirmDisabled={unlinkCount === undefined}
        onConfirm={handleConfirmUnlink}
      >
        <p>
          Every link from this project to the vocabulary's entries is removed. The vocabulary
          remains available to other projects.
        </p>
        {onCountLinks && (
          <p>
            {unlinkCount === undefined && 'Counting links…'}
            {unlinkCount === null && 'The number of links could not be read.'}
            {unlinkCount === 0 && 'This project has no links to its entries.'}
            {unlinkCount > 0 && (
              <>
                This project has <strong>{countOf(unlinkCount, 'link', 'links')}</strong> to its
                entries.
              </>
            )}
          </p>
        )}
      </ConfirmDeleteDialog>
    </div>
  );
};
