import { useState, useEffect } from 'react';
import { Plus, Trash2, Check, X, ChevronUp, ChevronDown, Unlink, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

export const VocabularyManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true,
  isSettings = false // New prop to control behavior differences
}) => {
  const [vocabularies, setVocabularies] = useState([]);
  const [newVocabName, setNewVocabName] = useState('');
  const [hoveredVocab, setHoveredVocab] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [unlinkModalOpened, setUnlinkModalOpened] = useState(false);
  const [vocabToUnlink, setVocabToUnlink] = useState(null);

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
        setError('Failed to load vocabularies');
        setVocabularies([]);
        setIsInitialized(true);

        if (onError) {
          onError(err);
        } else {
          notifyError('Failed to load vocabularies configuration', 'Load Error');
        }
      } finally {
        setLoading(false);
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newVocabularies) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ vocabularies: newVocabularies });
      }
      setVocabularies(newVocabularies);
    } catch (error) {
      console.error('Failed to save vocabularies configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifyError('Failed to save vocabularies configuration', 'Save Error');
      }
    }
  };

  const handleVocabToggle = async (vocabId, enabled) => {
    // For settings mode, handle unlinking with confirmation
    if (isSettings && !enabled) {
      const vocab = vocabularies.find(v => v.id === vocabId);
      if (vocab) {
        setVocabToUnlink(vocab);
        openUnlinkModal();
        return;
      }
    }

    const updatedVocabs = vocabularies.map(vocab =>
      vocab.id === vocabId ? { ...vocab, enabled } : vocab
    );
    await saveChanges(updatedVocabs);
  };

  const handleConfirmUnlink = async () => {
    if (!vocabToUnlink) return;

    const updatedVocabs = vocabularies.map(vocab =>
      vocab.id === vocabToUnlink.id ? { ...vocab, enabled: false } : vocab
    );
    await saveChanges(updatedVocabs);

    closeUnlinkModal();
    setVocabToUnlink(null);
  };

  const handleAddCustomVocab = async () => {
    const trimmedName = newVocabName.trim();

    if (!trimmedName) {
      notifyError('Vocabulary name cannot be empty', 'Invalid Vocabulary Name');
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = vocabularies.some(vocab =>
      vocab.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifyError('A vocabulary with this name already exists', 'Duplicate Vocabulary');
      return;
    }

    const newVocab = {
      name: trimmedName,
      id: `new-${Date.now()}`, // Temporary ID for new vocabs
      enabled: true, // New custom vocabs are enabled by default
      isCustom: true
    };

    const updatedVocabs = [...vocabularies, newVocab];
    await saveChanges(updatedVocabs);

    setNewVocabName('');
    notifySuccess(`"${trimmedName}" has been added to your vocabularies`, 'Vocabulary Added');
  };

  const handleDeleteCustomVocab = async (vocabId) => {
    const vocabToDelete = vocabularies.find(v => v.id === vocabId);
    const updatedVocabs = vocabularies.filter(vocab => vocab.id !== vocabId);
    await saveChanges(updatedVocabs);

    notifyInfo(`"${vocabToDelete?.name}" has been removed`, 'Vocabulary Removed');
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
    return vocabularies.some(vocab =>
      vocab.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveVocab = async (vocabId, direction) => {
    const currentIndex = vocabularies.findIndex(vocab => vocab.id === vocabId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= vocabularies.length) return;

    const newVocabs = [...vocabularies];
    const [movedVocab] = newVocabs.splice(currentIndex, 1);
    newVocabs.splice(newIndex, 0, movedVocab);

    await saveChanges(newVocabs);
  };

  // Don't render until initialized
  if (!isInitialized || loading) {
    return (
      <div className="flex flex-col items-center gap-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <p className="text-sm">Loading vocabularies...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Error</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Prepare data for the table
  const tableData = vocabularies.map((vocab, index) => ({
    ...vocab,
    tableId: `${vocab.name}-${index}` // Unique ID for table
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* Vocabularies Table. Embedded in a settings section, the parent supplies
          the card chrome — don't nest another bordered card. */}
      <div className={showTitle ? 'rounded-lg border bg-card p-4' : ''}>
        {showTitle && <p className="mb-4 text-sm font-medium">Available Vocabularies</p>}

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="w-[10%] px-3 py-2 text-left font-medium">Link</th>
                <th className="px-3 py-2 text-left font-medium">Vocabulary Name</th>
              </tr>
            </thead>
            <tbody>
              {tableData.map((record) => (
                <tr
                  key={record.tableId}
                  className="cursor-pointer border-t hover:bg-muted/50"
                  onMouseEnter={() => setHoveredVocab(record.id)}
                  onMouseLeave={() => setHoveredVocab(null)}
                  onClick={() => handleVocabToggle(record.id, !record.enabled)}
                >
                  <td className="px-3 py-2">
                    {record.enabled ? (
                      <Check className="h-[18px] w-[18px] text-green-600" />
                    ) : (
                      <X className="h-[18px] w-[18px] text-gray-400" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          record.enabled ? '' : 'italic text-muted-foreground'
                        )}
                      >
                        {record.name}
                      </span>
                      <div className="flex items-center gap-2">
                        {/* Only show move buttons in setup mode */}
                        {!isSettings && (
                          <>
                            <Button
                              size="icon"
                              variant="outline"
                              className={cn(
                                'h-7 w-7 transition-opacity',
                                hoveredVocab === record.id ? 'opacity-100' : 'opacity-0'
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveVocab(record.id, 'up');
                              }}
                              disabled={tableData.findIndex(item => item.id === record.id) === 0}
                            >
                              <ChevronUp className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              className={cn(
                                'h-7 w-7 transition-opacity',
                                hoveredVocab === record.id ? 'opacity-100' : 'opacity-0'
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveVocab(record.id, 'down');
                              }}
                              disabled={tableData.findIndex(item => item.id === record.id) === tableData.length - 1}
                            >
                              <ChevronDown className="h-3 w-3" />
                            </Button>
                          </>
                        )}

                        {/* Show unlink button for enabled vocabs in settings mode */}
                        {isSettings && record.enabled && (
                          <Button
                            size="icon"
                            variant="outline"
                            className={cn(
                              'h-7 w-7 text-orange-600 transition-opacity hover:text-orange-600',
                              hoveredVocab === record.id ? 'opacity-100' : 'opacity-0'
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
                            variant="outline"
                            className={cn(
                              'h-7 w-7 text-destructive transition-opacity hover:text-destructive',
                              hoveredVocab === record.id ? 'opacity-100' : 'opacity-0'
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
        </div>

        {/* Add Custom Vocab - only in setup mode */}
        {!isSettings && (
          <div className="mt-4">
            <p className="mb-4 text-sm font-medium">Add New Vocabulary</p>
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
                <Plus className="h-4 w-4" /> Add Vocabulary
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Unlink Confirmation Modal */}
      <Dialog open={unlinkModalOpened} onOpenChange={(o) => { if (!o) closeUnlinkModal(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlink Vocabulary</DialogTitle>
          </DialogHeader>

          <div className="rounded-md border border-orange-500/50 bg-orange-500/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-orange-600" />
              <div>
                <p className="text-sm font-medium text-orange-600">Warning</p>
                <p className="text-sm text-muted-foreground">
                  You are about to unlink the vocabulary <strong>"{vocabToUnlink?.name}"</strong> from this project.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This will delete all vocabulary item links for this vocabulary in this project.
                  The vocabulary itself will remain available for other projects.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={closeUnlinkModal}
            >
              Cancel
            </Button>
            <Button
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={handleConfirmUnlink}
            >
              <Unlink className="h-4 w-4" /> Unlink Vocabulary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
