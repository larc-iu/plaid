import { useState, useEffect, useMemo, useRef } from 'react';
import { Info, Check } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { findBaselineTextLayer } from '@/domain/igtConfig';

// When initializing an EXISTING project, the only thing a user might need to
// decide is which text layer is the baseline — and even that is automatic when
// another Plaid app has already tagged one (role=baseline). The word, morpheme,
// sentence, and alignment token layers are ALWAYS found-or-created by role and
// auto-named; they are purely internal (the app never surfaces their names to
// the user, unlike span layers), so we never prompt for a name. See the
// interoperability model in plaid-core/docs/manual.adoc.
export const LayerSelectionStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const textLayers = useMemo(() => project?.textLayers || [], [project]);

  // A baseline text layer already tagged by another Plaid app is adopted
  // automatically — the user chooses nothing.
  const adoptedBaseline = useMemo(() => findBaselineTextLayer(textLayers), [textLayers]);

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

  // Seed a sensible default exactly once per project load (guarded by a ref so
  // it doesn't re-fire on every parent re-render). When a role-tagged baseline
  // exists we adopt it; otherwise auto-select the sole text layer, or default to
  // creating a new one when the project has none.
  const didInitDefaultsRef = useRef(false);
  useEffect(() => {
    if (!project) return;
    if (didInitDefaultsRef.current) return;
    didInitDefaultsRef.current = true;

    if (adoptedBaseline) {
      onDataChange({ ...data, textLayerType: 'adopted', adoptedBaselineId: adoptedBaseline.id });
    } else if (textLayers.length === 1) {
      onDataChange({ ...data, textLayerType: 'existing', selectedTextLayerId: textLayers[0].id });
    } else if (textLayers.length === 0) {
      onDataChange({ ...data, textLayerType: 'new' });
    }
  }, [project, textLayers, adoptedBaseline, data, onDataChange]);

  const handleTextLayerTypeChange = (value) => {
    onDataChange({
      ...data,
      textLayerType: value,
      selectedTextLayerId: null,
    });
  };

  const handleTextLayerSelectionChange = (value) => {
    onDataChange({
      ...data,
      selectedTextLayerId: value,
    });
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

  // A Plaid-compatible baseline already exists (e.g. this project was set up in
  // another Plaid app). Nothing to choose — reassure and move on.
  if (adoptedBaseline) {
    return (
      <div className="tw flex flex-col gap-6">
        <div className="rounded-md border border-border bg-muted p-4">
          <div className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <div className="text-sm">
              <p className="font-medium">This project already has a compatible text layer</p>
              <p className="mt-1 text-muted-foreground">
                Plaid IGT will reuse the existing baseline text layer and automatically
                create any word, morpheme, sentence, and alignment layers it needs.
                There's nothing to configure here — continue to the next step.
              </p>
            </div>
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
          Choose the text layer Plaid IGT should use as the baseline.
          <strong> Text layers</strong> contain the baseline text content of your documents.
          The word and morpheme token layers are created automatically — you don't need to
          name them.
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
            <p className="ml-6 text-sm text-muted-foreground">
              A new baseline text layer will be created automatically.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// Validation function for this step. Token/morpheme layers are never named by
// the user, so the only requirement is a resolved baseline text layer.
LayerSelectionStep.isValid = (data) => {
  if (data?.textLayerType === 'adopted') return true;
  if (data?.textLayerType === 'existing') return !!data?.selectedTextLayerId;
  if (data?.textLayerType === 'new') return true;
  return false;
};
