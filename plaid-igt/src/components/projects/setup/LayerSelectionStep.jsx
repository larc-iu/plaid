import { useState, useEffect, useMemo, useRef } from 'react';
import { Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const LayerSelectionStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Extract text layers from project data
  const textLayers = useMemo(() => {
    if (!project) return [];
    return project.textLayers || [];
  }, [project]);

  // Fetch project data on mount
  useEffect(() => {
    const fetchProjectData = async () => {
      try {
        setLoading(true);
        if (!client) throw new Error('Not authenticated');

        const projectData = await client.projects.get(projectId);
        setProject(projectData);
        setError('');
      } catch (err) {
        console.error('Error fetching project:', err);
        setError('Failed to load project data');
      } finally {
        setLoading(false);
      }
    };

    if (projectId) {
      fetchProjectData();
    }
  }, [projectId, client]);

  // Ensure token/morpheme layer types are always 'new' (the only supported option,
  // since overlap-mode and parent-token-layer-id are immutable after creation).
  // Also auto-select text layer when there's exactly one.
  //
  // Runs exactly once per project load (guarded by a ref) so we don't re-fire
  // every time the parent re-renders with a fresh onDataChange identity.
  const didInitDefaultsRef = useRef(false);
  useEffect(() => {
    if (!project || !textLayers) return;
    if (didInitDefaultsRef.current) return;

    const updates = {};
    let needsUpdate = false;

    if (data?.tokenLayerType !== 'new') {
      updates.tokenLayerType = 'new';
      needsUpdate = true;
    }
    if (data?.morphemeLayerType !== 'new') {
      updates.morphemeLayerType = 'new';
      needsUpdate = true;
    }

    // Auto-select text layer if there's exactly one
    if (textLayers.length === 1 && !data?.textLayerType) {
      updates.textLayerType = 'existing';
      updates.selectedTextLayerId = textLayers[0].id;
      needsUpdate = true;
    }

    didInitDefaultsRef.current = true;

    if (needsUpdate) {
      onDataChange({ ...data, ...updates });
    }
  }, [project, textLayers, data, onDataChange]);

  const handleTextLayerTypeChange = (value) => {
    const newData = {
      ...data,
      textLayerType: value,
      selectedTextLayerId: null,
      newTextLayerName: ''
    };
    onDataChange(newData);
  };

  const handleTextLayerSelectionChange = (value) => {
    const newData = {
      ...data,
      selectedTextLayerId: value
    };
    onDataChange(newData);
  };

  const handleNewTextLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTextLayerName: event.currentTarget.value
    });
  };

  const handleNewTokenLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTokenLayerName: event.currentTarget.value
    });
  };

  const handleNewMorphemeLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newMorphemeLayerName: event.currentTarget.value
    });
  };

  // Check if we have a valid text layer selection
  const hasValidTextLayerSelection = () => {
    if (data?.textLayerType === 'existing') {
      return !!data?.selectedTextLayerId;
    }
    if (data?.textLayerType === 'new') {
      return !!(data?.newTextLayerName?.trim());
    }
    return false;
  };

  if (loading) {
    return (
      <div className="tw flex flex-col items-center gap-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm">Loading project layers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tw rounded-md border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Error</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const selectableTextLayers = textLayers.filter(layer => layer.id);

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          Choose a text layer for Plaid Base to use, then provide names for the new
          token and morpheme layers that will be created.
          <strong> Text layers</strong> contain the baseline text content of your documents.
          <strong> Token layers</strong> define the units for analysis (words and morphemes)
          and serve as the foundation for further annotation layers. Token and morpheme
          layers are always created fresh because their overlap mode and hierarchy are
          fixed at creation time.
        </p>
      </div>

      {/* Text Layer Selection */}
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-4 font-medium">Text Layer</p>

        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="textLayerType"
              className="h-4 w-4"
              value="existing"
              checked={data?.textLayerType === 'existing'}
              onChange={(e) => handleTextLayerTypeChange(e.target.value)}
              disabled={selectableTextLayers.length === 0}
            />
            Use existing text layer
          </label>
          {data?.textLayerType === 'existing' && selectableTextLayers.length > 0 && (
            <div className="ml-6">
              <Select
                value={data?.selectedTextLayerId || undefined}
                onValueChange={handleTextLayerSelectionChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a text layer" />
                </SelectTrigger>
                <SelectContent>
                  {selectableTextLayers.map(layer => (
                    <SelectItem key={layer.id} value={layer.id}>
                      {layer.name || layer.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {data?.textLayerType === 'existing' && selectableTextLayers.length === 0 && (
            <p className="ml-6 text-sm text-muted-foreground">No existing text layers found</p>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="textLayerType"
              className="h-4 w-4"
              value="new"
              checked={data?.textLayerType === 'new'}
              onChange={(e) => handleTextLayerTypeChange(e.target.value)}
            />
            Create new text layer
          </label>
          {data?.textLayerType === 'new' && (
            <div className="ml-6">
              <Input
                placeholder="Enter text layer name"
                value={data?.newTextLayerName || ''}
                onChange={handleNewTextLayerNameChange}
              />
            </div>
          )}
        </div>
      </div>

      {/* Token Layer (always new) */}
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-4 font-medium">Primary Token Layer</p>

        {!hasValidTextLayerSelection() ? (
          <p className="text-sm text-muted-foreground">Please select a text layer first</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              A new primary (word-level) token layer will be created. Name it:
            </p>
            <Input
              placeholder="e.g. Main Tokens"
              value={data?.newTokenLayerName || ''}
              onChange={handleNewTokenLayerNameChange}
            />
          </div>
        )}
      </div>

      {/* Morpheme Layer (always new) */}
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-4 font-medium">Morpheme Token Layer</p>

        {!hasValidTextLayerSelection() ? (
          <p className="text-sm text-muted-foreground">Please select a text layer first</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              A new morpheme token layer will be created under the primary token layer. Name it:
            </p>
            <Input
              placeholder="e.g. Main Morphemes"
              value={data?.newMorphemeLayerName || ''}
              onChange={handleNewMorphemeLayerNameChange}
            />
          </div>
        )}
      </div>
    </div>
  );
};

// Validation function for this step
LayerSelectionStep.isValid = (data) => {
  // Must have valid text layer selection
  const hasValidTextLayer =
    (data?.textLayerType === 'existing' && data?.selectedTextLayerId) ||
    (data?.textLayerType === 'new' && data?.newTextLayerName?.trim());

  // Token and morpheme layers are always created new; require non-empty names.
  const hasValidTokenLayer = !!(data?.newTokenLayerName?.trim());
  const hasValidMorphemeLayer = !!(data?.newMorphemeLayerName?.trim());

  return hasValidTextLayer && hasValidTokenLayer && hasValidMorphemeLayer;
};
