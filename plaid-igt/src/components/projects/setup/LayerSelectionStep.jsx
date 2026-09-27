import { useState, useEffect, useMemo, useRef } from 'react';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { findBaselineTextLayer } from '@/domain/igtConfig';
import { humanizeError } from '@/utils/feedback';

// When initializing an EXISTING project, the only thing a user might need to
// decide is which text layer is the baseline — and even that is automatic when
// another Plaid app has already tagged one (role=baseline). The word, morpheme,
// sentence, and alignment token layers are ALWAYS found-or-created by role and
// auto-named; they are purely internal (the app never surfaces their names to
// the user, unlike span layers), so we never prompt for a name. See the
// interoperability model in plaid-core/docs/manual.adoc.
export const LayerSelectionStep = ({ data, onDataChange, projectId, client }) => {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const textLayers = useMemo(() => project?.textLayers || [], [project]);

  // A baseline text layer already tagged by another Plaid app is adopted
  // automatically — the user chooses nothing.
  const adoptedBaseline = useMemo(() => findBaselineTextLayer(textLayers), [textLayers]);

  // Fetch project data on mount
  useEffect(() => {
    let cancelled = false;
    const fetchProjectData = async () => {
      try {
        setLoading(true);
        if (!client) throw new Error('Not authenticated');

        const projectData = await client.projects.get(projectId);
        if (cancelled) return;
        setProject(projectData);
        setError('');
      } catch (err) {
        if (cancelled) return;
        console.error('Error fetching project:', err);
        setError(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (projectId) {
      fetchProjectData();
    }
    // The project can change under the wizard, and the answer for the one just
    // left must not fill this step in.
    return () => {
      cancelled = true;
    };
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
      onDataChange({
        ...data,
        textLayerType: 'existing',
        selectedTextLayerId: textLayers[0].id,
        selectedTextLayerName: textLayers[0].name,
      });
    } else if (textLayers.length === 0) {
      onDataChange({ ...data, textLayerType: 'new' });
    }
  }, [project, textLayers, adoptedBaseline, data, onDataChange]);

  const handleTextLayerTypeChange = (value) => {
    onDataChange({
      ...data,
      textLayerType: value,
      selectedTextLayerId: null,
      selectedTextLayerName: null,
    });
  };

  const handleTextLayerSelectionChange = (value) => {
    onDataChange({
      ...data,
      selectedTextLayerId: value,
      selectedTextLayerName: textLayers.find((layer) => layer.id === value)?.name ?? null,
    });
  };

  if (loading) {
    return <Loading label="Loading…" className="p-0 text-center" />;
  }

  if (error) {
    return (
      <Notice tone="error" className="p-4">
        <p className="font-medium">Failed to load the project</p>
        <p className="mt-1 text-muted-foreground">{error}</p>
      </Notice>
    );
  }

  // A Plaid-compatible baseline already exists (e.g. this project was set up in
  // another Plaid app). Nothing to choose — reassure and move on.
  if (adoptedBaseline) {
    return (
      <div className="flex flex-col gap-6">
        <Notice tone="info" className="p-4">
          <p className="font-medium">This project already has a compatible text layer</p>
          <p className="mt-1">
            Plaid IGT uses the existing baseline text layer and creates the word, morpheme,
            sentence, and alignment layers it needs.
          </p>
        </Notice>
      </div>
    );
  }

  const selectableTextLayers = textLayers.filter((layer) => layer.id);

  return (
    <div className="flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          Choose the text layer Plaid IGT should use as the baseline.
          <strong> Text layers</strong> hold the baseline text of your documents. The word and
          morpheme token layers are created with it.
        </p>
      </div>

      {/* Text Layer Selection */}
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-4 font-medium">Text layer</p>

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
                  {selectableTextLayers.map((layer) => (
                    <SelectItem key={layer.id} value={layer.id}>
                      {layer.name || layer.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {data?.textLayerType === 'existing' && selectableTextLayers.length === 0 && (
            <p className="ml-6 text-sm text-muted-foreground">No text layers</p>
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
            <p className="ml-6 text-sm text-muted-foreground">Creates a new baseline text layer.</p>
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
