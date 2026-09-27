import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Unlink } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { SearchInput, ListCount, ListPager } from '@ui/components/shared/list-search';
import { usePagedList } from '@ui/hooks/usePagedList';
import { Button } from '@ui/components/ui/button';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { ROW_DELETE_CLASS } from '@ui/lib/destructive.js';
import { cn } from '@ui/lib/utils';
import { notifyError } from '@/utils/feedback';
import { textIncludes } from '@ui/domain/collation.js';

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
  isSettings = false, // New prop to control behavior differences
}) => {
  const [vocabularies, setVocabularies] = useState([]);
  const [newVocabName, setNewVocabName] = useState('');
  const [query, setQuery] = useState('');
  const [hoveredVocab, setHoveredVocab] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [unlinkModalOpened, setUnlinkModalOpened] = useState(false);
  const [vocabToUnlink, setVocabToUnlink] = useState(null);

  // Sends wait their turn, so two quick ticks reach the server in order.
  const sends = useRef(Promise.resolve());

  const openUnlinkModal = () => setUnlinkModalOpened(true);
  const closeUnlinkModal = () => setUnlinkModalOpened(false);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        setLoading(true);
        let vocabData = initialData;

        // If no initial data provided or if vocabularies array is missing, try loading from callback
        if ((!vocabData || !vocabData.vocabularies) && onLoadData) {
          vocabData = await onLoadData();
        }

        // If still no data, use empty array
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
    // For settings mode, handle unlinking with confirmation
    if (isSettings && !enabled) {
      const vocab = vocabularies.find((v) => v.id === vocabId);
      if (vocab) {
        setVocabToUnlink(vocab);
        openUnlinkModal();
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
    // "Unlink vocabulary “”" for the length of the fade. The next open
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

    // Check for duplicate names (case insensitive)
    const isDuplicate = vocabularies.some(
      (vocab) => vocab.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (isDuplicate) {
      notifyError('A vocabulary with this name already exists', 'Duplicate vocabulary');
      return;
    }

    const newVocab = {
      name: trimmedName,
      id: customVocabId(),
      enabled: true, // New custom vocabs are enabled by default
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

  // Check if new vocab name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newVocabName.trim();
    if (!trimmedName) return false;
    return vocabularies.some((vocab) => vocab.name.toLowerCase() === trimmedName.toLowerCase());
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
    tableId: `${vocab.name}-${index}`, // Unique ID for table
  }));
  // Searched and paged, as every other browsable list in the app is. Every
  // vocabulary on the server lands here, and on a shared server that is a
  // hundred rows, dozens of them named "Lexicon", with the Add field and the
  // wizard's Next button below all of it. Picking a colleague's lexicon out of
  // that was not realistically possible.
  const q = query.trim().toLowerCase();
  const shown = q ? tableData.filter((v) => textIncludes(v.name || '', q)) : tableData;
  const paged = usePagedList(shown, { resetKey: q });

  // Don't render until initialized
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
                  onMouseEnter={() => setHoveredVocab(record.id)}
                  onMouseLeave={() => setHoveredVocab(null)}
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
                        {record.name}
                        {isLocked(record) && (
                          <span className="block text-xs not-italic text-muted-foreground">
                            Only its maintainers can link it.
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {/* Only show move buttons in setup mode, and only for
                            vocabs that are actually being linked — ordering an
                            unlinked row is meaningless. */}
                        {!isSettings && record.enabled && (
                          <>
                            <Button
                              size="icon"
                              variant="outline"
                              className={cn(
                                'h-7 w-7 transition-opacity',
                                hoveredVocab === record.id ? 'opacity-100' : 'opacity-0',
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveVocab(record.id, 'up');
                              }}
                              disabled={linkedNeighbour(record.id, 'up') === -1}
                            >
                              <ChevronUp className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              className={cn(
                                'h-7 w-7 transition-opacity',
                                hoveredVocab === record.id ? 'opacity-100' : 'opacity-0',
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveVocab(record.id, 'down');
                              }}
                              disabled={linkedNeighbour(record.id, 'down') === -1}
                            >
                              <ChevronDown className="h-3 w-3" />
                            </Button>
                          </>
                        )}

                        {/* Show unlink button for enabled vocabs in settings mode */}
                        {isSettings && record.enabled && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className={cn(
                              'h-7 w-7 transition-opacity',
                              ROW_DELETE_CLASS,
                              hoveredVocab === record.id ? 'opacity-100' : 'opacity-0',
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleVocabToggle(record.id, false);
                            }}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                          </Button>
                        )}

                        {/* Only show delete button for custom vocabs in setup mode */}
                        {!isSettings && record.isCustom && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${record.name}`}
                            className={cn(
                              'h-7 w-7 transition-opacity',
                              ROW_DELETE_CLASS,
                              hoveredVocab === record.id ? 'opacity-100' : 'opacity-0',
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeleteCustomVocab(record.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager {...paged} />
        </div>

        {/* Add Custom Vocab - only in setup mode */}
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

      {/* Unlink Confirmation Modal */}
      <ConfirmDeleteDialog
        open={unlinkModalOpened}
        onOpenChange={(o) => {
          if (!o) closeUnlinkModal();
        }}
        title={`Unlink vocabulary “${vocabToUnlink?.name ?? ''}”`}
        confirmLabel="Unlink"
        onConfirm={handleConfirmUnlink}
      >
        <p>
          Every link from this project to the vocabulary's entries is removed. The vocabulary
          remains available to other projects.
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};
