import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  UD_NAMESPACE,
  UD_TEXT_CONFIG_KEY,
  UD_TOKEN_CONFIG_KEY,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
  UD_LAYER_LABELS,
  getUdLayerInfo
} from '../../utils/udLayerUtils.js';
import { Button, FormField, ErrorMessage } from '../ui';

const SPAN_KEYS_IN_ORDER = ['lemma', 'upos', 'xpos', 'features', 'sentence', 'mwt'];
const DEFAULT_NAMES = {
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features',
  sentence: 'Sentence',
  mwt: 'Multi-word Tokens'
};

export const ProjectConfiguration = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    textLayerType: 'existing',
    selectedTextLayerId: '',
    newTextLayerName: 'Text',
    tokenLayerType: 'existing',
    selectedTokenLayerId: '',
    newTokenLayerName: 'Token',
    spans: SPAN_KEYS_IN_ORDER.reduce((acc, key) => {
      acc[key] = {
        mode: 'existing',
        selectedId: '',
        newName: DEFAULT_NAMES[key]
      };
      return acc;
    }, {})
  });

  const fetchProject = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      const data = await client.projects.get(projectId);
      setProject(data);
      setError('');
      return data;
    } catch (err) {
      console.error('Failed to load project configuration:', err);
      setError('Failed to load project configuration.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProject();
  }, [projectId]);

  const isAdmin = user?.isAdmin || false;
  const isMaintainer = project?.maintainers?.includes(user?.id) || false;
  const canConfigure = isAdmin || isMaintainer;

  useEffect(() => {
    if (project && !canConfigure) {
      navigate('/projects');
    }
  }, [project, canConfigure, navigate]);

  const availableTextLayers = project?.textLayers || [];

  const tokenLayersByTextLayer = useMemo(() => {
    if (!project?.textLayers) return {};
    return project.textLayers.reduce((acc, textLayer) => {
      acc[textLayer.id] = textLayer.tokenLayers || [];
      return acc;
    }, {});
  }, [project]);

  const availableTokenLayers = tokenLayersByTextLayer[formData.selectedTextLayerId] || [];

  const spanLayersByTokenLayer = useMemo(() => {
    const map = {};
    Object.values(tokenLayersByTextLayer).forEach(tokenLayers => {
      tokenLayers.forEach(tokenLayer => {
        map[tokenLayer.id] = tokenLayer.spanLayers || [];
      });
    });
    return map;
  }, [tokenLayersByTextLayer]);

  const availableSpanLayers = spanLayersByTokenLayer[formData.selectedTokenLayerId] || [];

  // Initialize form defaults when project data becomes available
  useEffect(() => {
    if (!project) return;

    const info = getUdLayerInfo(project);
    const missingSet = new Set(info.missingLayers || []);

    const hasExistingTextConfig = info.textLayer && !missingSet.has('textLayer');
    const selectedTextLayerId = hasExistingTextConfig
      ? info.textLayer.id
      : (availableTextLayers[0]?.id || '');

    const tokenLayersForText = tokenLayersByTextLayer[selectedTextLayerId] || [];
    const hasExistingTokenConfig = info.tokenLayer && !missingSet.has('tokenLayer');

    const initialData = {
      textLayerType: hasExistingTextConfig ? 'existing' : (availableTextLayers.length === 0 ? 'new' : 'existing'),
      selectedTextLayerId: hasExistingTextConfig ? info.textLayer.id : selectedTextLayerId,
      newTextLayerName: 'Text',
      tokenLayerType: hasExistingTokenConfig ? 'existing' : (tokenLayersForText.length === 0 ? 'new' : 'existing'),
      selectedTokenLayerId: hasExistingTokenConfig ? info.tokenLayer.id : (tokenLayersForText[0]?.id || ''),
      newTokenLayerName: 'Token',
      spans: {}
    };

    if (initialData.textLayerType === 'new') {
      initialData.selectedTextLayerId = '';
    }
    if (initialData.tokenLayerType === 'new') {
      initialData.selectedTokenLayerId = '';
    }

    SPAN_KEYS_IN_ORDER.forEach(key => {
      const layerProperty = `${key}Layer`;
      const existingLayer = info[layerProperty];
      const hasConfig = existingLayer && !missingSet.has(key);
      initialData.spans[key] = {
        mode: hasConfig ? 'existing' : 'existing',
        selectedId: hasConfig ? existingLayer.id : '',
        newName: DEFAULT_NAMES[key]
      };
    });

    setFormData(initialData);
  }, [project, availableTextLayers, tokenLayersByTextLayer]);

  const handleTextLayerTypeChange = (mode) => {
    setFormData(prev => ({
      ...prev,
      textLayerType: mode,
      selectedTextLayerId: mode === 'existing' ? prev.selectedTextLayerId : '',
      newTextLayerName: mode === 'new' ? (prev.newTextLayerName || 'Text') : prev.newTextLayerName,
      // Reset token selection when text layer changes
      tokenLayerType: mode === 'existing' ? prev.tokenLayerType : 'new',
      selectedTokenLayerId: mode === 'existing' ? prev.selectedTokenLayerId : '',
      spans: SPAN_KEYS_IN_ORDER.reduce((acc, key) => {
        const previous = prev.spans[key];
        acc[key] = {
          mode: mode === 'existing' ? previous.mode : 'new',
          selectedId: mode === 'existing' ? previous.selectedId : '',
          newName: previous.newName || DEFAULT_NAMES[key]
        };
        return acc;
      }, {})
    }));
  };

  const handleTokenLayerTypeChange = (mode) => {
    setFormData(prev => ({
      ...prev,
      tokenLayerType: mode,
      selectedTokenLayerId: mode === 'existing' ? prev.selectedTokenLayerId : '',
      newTokenLayerName: mode === 'new' ? (prev.newTokenLayerName || 'Token') : prev.newTokenLayerName,
      spans: SPAN_KEYS_IN_ORDER.reduce((acc, key) => {
        const previous = prev.spans[key];
        acc[key] = {
          mode: mode === 'existing' ? previous.mode : 'new',
          selectedId: mode === 'existing' ? previous.selectedId : '',
          newName: previous.newName || DEFAULT_NAMES[key]
        };
        return acc;
      }, {})
    }));
  };

  const updateSpanConfig = (key, updates) => {
    setFormData(prev => ({
      ...prev,
      spans: {
        ...prev.spans,
        [key]: {
          ...prev.spans[key],
          ...updates
        }
      }
    }));
  };

  const handleTextLayerSelection = (layerId) => {
    const tokenLayers = tokenLayersByTextLayer[layerId] || [];
    setFormData(prev => ({
      ...prev,
      selectedTextLayerId: layerId,
      tokenLayerType: tokenLayers.length === 0 ? 'new' : prev.tokenLayerType,
      selectedTokenLayerId: tokenLayers.length > 0 ? tokenLayers[0].id : '',
      spans: SPAN_KEYS_IN_ORDER.reduce((acc, key) => {
        const current = prev.spans[key];
        acc[key] = {
          ...current,
          selectedId: current.mode === 'existing' ? '' : current.selectedId
        };
        return acc;
      }, {})
    }));
  };

  const handleTokenLayerSelection = (layerId) => {
    setFormData(prev => ({
      ...prev,
      selectedTokenLayerId: layerId,
      spans: SPAN_KEYS_IN_ORDER.reduce((acc, key) => {
        const current = prev.spans[key];
        acc[key] = {
          ...current,
          selectedId: current.mode === 'existing' ? '' : current.selectedId
        };
        return acc;
      }, {})
    }));
  };

  const validateForm = () => {
    if (formData.textLayerType === 'existing' && !formData.selectedTextLayerId) {
      return 'Select a text layer or choose to create a new one.';
    }
    if (formData.textLayerType === 'new' && !formData.newTextLayerName.trim()) {
      return 'Provide a name for the new text layer.';
    }
    if (formData.tokenLayerType === 'existing' && !formData.selectedTokenLayerId) {
      return 'Select a token layer or choose to create a new one.';
    }
    if (formData.tokenLayerType === 'new' && !formData.newTokenLayerName.trim()) {
      return 'Provide a name for the new token layer.';
    }

    for (const key of SPAN_KEYS_IN_ORDER) {
      const config = formData.spans[key];
      const canUseExisting = formData.tokenLayerType === 'existing' && availableSpanLayers.length > 0;
      if (config.mode === 'existing') {
        if (!canUseExisting) {
          continue;
        }
        if (!config.selectedId) {
          return `Select an existing layer for ${UD_LAYER_LABELS[key]} or choose to create a new one.`;
        }
      }
      if (config.mode === 'new' && !config.newName.trim()) {
        return `Provide a name for the new ${UD_LAYER_LABELS[key].toLowerCase()}.`;
      }
    }

    return '';
  };

  const createOrSelectSpanLayer = async (client, tokenLayerId, key, config) => {
    if (config.mode === 'existing') {
      await client.spanLayers.setConfig(config.selectedId, UD_NAMESPACE, UD_SPAN_CONFIG_KEYS[key], true);
      return config.selectedId;
    }

    const name = config.newName?.trim() || DEFAULT_NAMES[key];
    const spanLayer = await client.spanLayers.create(tokenLayerId, name);
    await client.spanLayers.setConfig(spanLayer.id, UD_NAMESPACE, UD_SPAN_CONFIG_KEYS[key], true);
    return spanLayer.id;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSuccessMessage('');

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      setSaving(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // 1. Text layer
      let textLayerId = formData.selectedTextLayerId;
      if (formData.textLayerType === 'new') {
        const name = formData.newTextLayerName.trim() || 'Text';
        const textLayer = await client.textLayers.create(projectId, name);
        textLayerId = textLayer.id;
      }
      await client.textLayers.setConfig(textLayerId, UD_NAMESPACE, UD_TEXT_CONFIG_KEY, true);

      // 2. Token layer
      let tokenLayerId = formData.selectedTokenLayerId;
      if (formData.tokenLayerType === 'new') {
        const name = formData.newTokenLayerName.trim() || 'Token';
        const tokenLayer = await client.tokenLayers.create(textLayerId, name);
        tokenLayerId = tokenLayer.id;
      }
      await client.tokenLayers.setConfig(tokenLayerId, UD_NAMESPACE, UD_TOKEN_CONFIG_KEY, true);

      // 3. Span layers
      const spanLayerIds = {};
      for (const key of SPAN_KEYS_IN_ORDER) {
        const config = formData.spans[key];
        const spanLayerId = await createOrSelectSpanLayer(client, tokenLayerId, key, config);
        spanLayerIds[key] = spanLayerId;
      }

      // 4. Relation layer for lemma
      const lemmaLayerId = spanLayerIds.lemma;
      let relationLayerId = null;
      const selectedTokenLayer = availableTokenLayers.find(layer => layer.id === tokenLayerId) || null;
      const existingLemmaLayer = selectedTokenLayer?.spanLayers?.find(layer => layer.id === lemmaLayerId);

      const relationCandidates = existingLemmaLayer?.relationLayers || [];
      relationLayerId = relationCandidates.find(layer => layer.config?.ud?.[UD_RELATION_CONFIG_KEY] === true)?.id
        || relationCandidates[0]?.id
        || null;

      if (!relationLayerId) {
        const relationLayer = await client.relationLayers.create(lemmaLayerId, 'Dependency Relations');
        relationLayerId = relationLayer.id;
      }

      await client.relationLayers.setConfig(relationLayerId, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);

      await fetchProject();
      setSuccessMessage('UD layer configuration saved successfully.');
    } catch (err) {
      console.error('Failed to save configuration:', err);
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-12">Loading project configuration...</div>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);
  const missingLabels = info.missingLayers?.length ? info.missingLayers.map(key => UD_LAYER_LABELS[key] || key).join(', ') : '';

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Configure UD Layers</h1>
          <p className="text-gray-600 mt-1">Project: {project.name}</p>
          {missingLabels && (
            <p className="text-sm text-amber-600 mt-2">Missing configuration detected for: {missingLabels}</p>
          )}
        </div>
        <Link
          to={`/projects/${projectId}/documents`}
          className="inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-blue-500 px-4 py-2 text-sm"
        >
          Back to Documents
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        <ErrorMessage message={error} />
        {successMessage && (
          <div className="rounded-md bg-green-50 border border-green-200 p-4 text-green-700 text-sm">
            {successMessage}
          </div>
        )}

        <section className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Text Layer</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  className="text-blue-600 focus:ring-blue-500"
                  checked={formData.textLayerType === 'existing'}
                  onChange={() => handleTextLayerTypeChange('existing')}
                />
                Use existing
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  className="text-blue-600 focus:ring-blue-500"
                  checked={formData.textLayerType === 'new'}
                  onChange={() => handleTextLayerTypeChange('new')}
                />
                Create new
              </label>
            </div>

            {formData.textLayerType === 'existing' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select text layer</label>
                <select
                  value={formData.selectedTextLayerId}
                  onChange={(e) => handleTextLayerSelection(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  <option value="">Select a text layer</option>
                  {availableTextLayers.map(layer => (
                    <option key={layer.id} value={layer.id}>{layer.name} ({layer.id})</option>
                  ))}
                </select>
              </div>
            ) : (
              <FormField
                label="New text layer name"
                name="newTextLayerName"
                value={formData.newTextLayerName}
                onChange={(e) => setFormData(prev => ({ ...prev, newTextLayerName: e.target.value }))}
                placeholder="e.g. Text"
              />
            )}
          </div>
        </section>

        <section className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Token Layer</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  className="text-blue-600 focus:ring-blue-500"
                  checked={formData.tokenLayerType === 'existing'}
                  onChange={() => handleTokenLayerTypeChange('existing')}
                  disabled={formData.textLayerType === 'new'}
                />
                Use existing
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  className="text-blue-600 focus:ring-blue-500"
                  checked={formData.tokenLayerType === 'new'}
                  onChange={() => handleTokenLayerTypeChange('new')}
                />
                Create new
              </label>
            </div>

            {formData.tokenLayerType === 'existing' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select token layer</label>
                <select
                  value={formData.selectedTokenLayerId}
                  onChange={(e) => handleTokenLayerSelection(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  <option value="">Select a token layer</option>
                  {availableTokenLayers.map(layer => (
                    <option key={layer.id} value={layer.id}>{layer.name} ({layer.id})</option>
                  ))}
                </select>
                {availableTokenLayers.length === 0 && (
                  <p className="text-xs text-gray-500 mt-1">No token layers found for the selected text layer.</p>
                )}
              </div>
            ) : (
              <FormField
                label="New token layer name"
                name="newTokenLayerName"
                value={formData.newTokenLayerName}
                onChange={(e) => setFormData(prev => ({ ...prev, newTokenLayerName: e.target.value }))}
                placeholder="e.g. Tokens"
              />
            )}
          </div>
        </section>

        <section className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Annotation Layers</h2>
          <p className="text-sm text-gray-600 mb-4">Select or create span layers for each Universal Dependencies annotation.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {SPAN_KEYS_IN_ORDER.map(key => {
              const config = formData.spans[key];
              const disableExisting = formData.tokenLayerType === 'new' || availableSpanLayers.length === 0;

              return (
                <div key={key} className="border border-gray-200 rounded-md p-4 bg-gray-50">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">{UD_LAYER_LABELS[key]}</h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-4">
                      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          className="text-blue-600 focus:ring-blue-500"
                          checked={config.mode === 'existing'}
                          onChange={() => updateSpanConfig(key, { mode: 'existing' })}
                          disabled={disableExisting}
                        />
                        Use existing
                      </label>
                      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          className="text-blue-600 focus:ring-blue-500"
                          checked={config.mode === 'new'}
                          onChange={() => updateSpanConfig(key, { mode: 'new' })}
                        />
                        Create new
                      </label>
                    </div>

                    {config.mode === 'existing' ? (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Select span layer</label>
                        <select
                          value={config.selectedId}
                          onChange={(e) => updateSpanConfig(key, { selectedId: e.target.value })}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                          disabled={disableExisting}
                        >
                          <option value="">Select a span layer</option>
                          {availableSpanLayers.map(layer => (
                            <option key={layer.id} value={layer.id}>{layer.name} ({layer.id})</option>
                          ))}
                        </select>
                        {disableExisting && (
                          <p className="text-xs text-gray-500 mt-1">Existing layers unavailable until token layer is selected.</p>
                        )}
                      </div>
                    ) : (
                      <FormField
                        label="New layer name"
                        name={`${key}-new-name`}
                        value={config.newName}
                        onChange={(e) => updateSpanConfig(key, { newName: e.target.value })}
                        placeholder={DEFAULT_NAMES[key]}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate(-1)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="dark"
            isLoading={saving}
            disabled={saving}
          >
            Save Configuration
          </Button>
        </div>
      </form>
    </div>
  );
};
