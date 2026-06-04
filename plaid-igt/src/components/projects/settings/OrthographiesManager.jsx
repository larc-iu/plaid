import { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// Predefined orthography setup
const DEFAULT_ORTHOGRAPHIES = [
  {
    name: 'Baseline',
    isBaseline: true, // Cannot be deleted
    isCustom: false
  },
  {
    name: 'IPA',
    isBaseline: false,
    isCustom: false
  }
];

export const OrthographiesManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true,
  autoSaveDefaults = false // Only auto-save defaults in setup mode
}) => {
  const [orthographies, setOrthographies] = useState([]);
  const [newOrthographyName, setNewOrthographyName] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        let orthographiesData = initialData;

        // If no initial data provided, try loading from callback
        if (!orthographiesData && onLoadData) {
          orthographiesData = await onLoadData();
        }

        // If still no data, use default orthographies
        if (!orthographiesData?.orthographies) {
          orthographiesData = {
            orthographies: DEFAULT_ORTHOGRAPHIES
          };
        }

        setOrthographies(orthographiesData.orthographies);
        setIsInitialized(true);

        // Important: If we're using default data and onSaveChanges exists AND autoSaveDefaults is enabled,
        // save the defaults to the parent setup wizard
        if (!initialData?.orthographies && onSaveChanges && autoSaveDefaults) {
          await onSaveChanges(orthographiesData);
        }
      } catch (error) {
        console.error('Failed to load orthographies configuration:', error);
        // Still set as initialized even on error, so we show the default orthographies
        const defaultData = { orthographies: DEFAULT_ORTHOGRAPHIES };
        setOrthographies(DEFAULT_ORTHOGRAPHIES);
        setIsInitialized(true);

        // Save defaults even on error (only in setup mode)
        if (onSaveChanges && autoSaveDefaults) {
          try {
            await onSaveChanges(defaultData);
          } catch (saveError) {
            console.error('Failed to save default orthographies:', saveError);
          }
        }

        if (onError) {
          onError(error);
        } else {
          notifyError('Failed to load orthographies configuration', 'Load Error');
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newOrthographies) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ orthographies: newOrthographies });
      }
      setOrthographies(newOrthographies);
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifyError('Failed to save orthographies configuration', 'Save Error');
      }
    }
  };

  const handleAddCustomOrthography = async () => {
    const trimmedName = newOrthographyName.trim();

    if (!trimmedName) {
      notifyError('Orthography name cannot be empty', 'Invalid Orthography Name');
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = orthographies.some(orth =>
      orth.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifyError('An orthography with this name already exists', 'Duplicate Orthography');
      return;
    }

    const newOrthography = {
      name: trimmedName,
      isBaseline: false,
      isCustom: true
    };

    const updatedOrthographies = [...orthographies, newOrthography];
    await saveChanges(updatedOrthographies);

    setNewOrthographyName('');
    notifySuccess(`"${trimmedName}" has been added to your orthographies`, 'Orthography Added');
  };

  const handleDeleteOrthography = async (orthographyName) => {
    // Cannot delete baseline orthography
    const orthography = orthographies.find(o => o.name === orthographyName);
    if (orthography?.isBaseline) {
      return;
    }

    const updatedOrthographies = orthographies.filter(orth => orth.name !== orthographyName);
    await saveChanges(updatedOrthographies);

    notifyInfo(`"${orthographyName}" has been removed`, 'Orthography Removed');
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomOrthography();
    }
  };

  // Check if new orthography name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newOrthographyName.trim();
    if (!trimmedName) return false;
    return orthographies.some(orth =>
      orth.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveOrthography = async (orthographyName, direction) => {
    // Cannot move baseline orthography (it must stay first)
    const orthography = orthographies.find(o => o.name === orthographyName);
    if (orthography?.isBaseline) {
      return;
    }

    const currentIndex = orthographies.findIndex(orth => orth.name === orthographyName);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    // Don't allow moving above baseline (index 0)
    if (newIndex <= 0 || newIndex >= orthographies.length) return;

    const newOrthographies = [...orthographies];
    const [movedOrthography] = newOrthographies.splice(currentIndex, 1);
    newOrthographies.splice(newIndex, 0, movedOrthography);

    await saveChanges(newOrthographies);
  };

  // Don't render until initialized
  if (!isInitialized) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        Loading orthographies configuration...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showTitle && <p className="text-sm font-medium">Available Orthographies</p>}

      {/* Orthographies list */}
      <div className="overflow-hidden rounded-md border">
        {orthographies.map((orth, index) => (
          <div
            key={`${orth.name}-${index}`}
            className="group flex items-center justify-between border-b px-3 py-2 last:border-b-0 hover:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">{orth.name}</span>
              {orth.isBaseline && (
                <Badge variant="secondary" className="text-[10px]">Required</Badge>
              )}
            </div>
            {!orth.isBaseline && (
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => handleMoveOrthography(orth.name, 'up')}
                  disabled={index <= 1}
                  title="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => handleMoveOrthography(orth.name, 'down')}
                  disabled={index === orthographies.length - 1}
                  title="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => handleDeleteOrthography(orth.name)}
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Custom Orthography */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Add Custom Orthography</p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Enter orthography name"
            value={newOrthographyName}
            onChange={(event) => setNewOrthographyName(event.target.value)}
            onKeyDown={handleKeyPress}
            className="flex-1"
          />
          <Button
            onClick={handleAddCustomOrthography}
            disabled={!newOrthographyName.trim() || wouldBeDuplicate()}
          >
            <Plus className="h-4 w-4" /> Add Orthography
          </Button>
        </div>
      </div>
    </div>
  );
};
