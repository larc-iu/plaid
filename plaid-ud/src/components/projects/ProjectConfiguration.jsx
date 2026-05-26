import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  UD_NAMESPACE,
  UD_TEXT_CONFIG_KEY,
  UD_TOKEN_CONFIG_KEYS,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
  UD_LAYER_LABELS,
  getUdLayerInfo
} from '../../utils/udLayerUtils.js';
import { Button, FormField, ErrorMessage } from '../ui';

// Span layers, in creation order, all attached to the morpheme token layer.
const SPAN_KEYS_IN_ORDER = ['form', 'lemma', 'upos', 'xpos', 'features'];
const SPAN_LAYER_NAMES = {
  form: 'Form',
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features'
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
    newTextLayerName: 'Text'
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

  // Initialize the text-layer choice once project data is available.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    const existingTextLayerId = info.textLayer?.id || availableTextLayers[0]?.id || '';
    setFormData({
      textLayerType: availableTextLayers.length === 0 ? 'new' : 'existing',
      selectedTextLayerId: existingTextLayerId,
      newTextLayerName: 'Text'
    });
  }, [project]);

  const validateForm = () => {
    if (formData.textLayerType === 'existing' && !formData.selectedTextLayerId) {
      return 'Select a text layer or choose to create a new one.';
    }
    if (formData.textLayerType === 'new' && !formData.newTextLayerName.trim()) {
      return 'Provide a name for the new text layer.';
    }
    return '';
  };

  // Find an existing UD-flagged child layer (idempotent re-configuration), else null.
  const findFlagged = (layers, namespace, key) =>
    (layers || []).find(layer => layer.config?.[namespace]?.[key] === true) || null;

  const ensureTokenLayer = async (client, textLayerId, existingTextLayer, configKey, name, overlapMode, parentId) => {
    const existing = findFlagged(existingTextLayer?.tokenLayers, UD_NAMESPACE, configKey);
    if (existing) return existing;
    const created = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
    await client.tokenLayers.setConfig(created.id, UD_NAMESPACE, configKey, true);
    return created;
  };

  const ensureSpanLayer = async (client, morphemeLayerId, existingMorphemeLayer, configKey, name) => {
    const existing = findFlagged(existingMorphemeLayer?.spanLayers, UD_NAMESPACE, configKey);
    if (existing) return existing;
    const created = await client.spanLayers.create(morphemeLayerId, name);
    await client.spanLayers.setConfig(created.id, UD_NAMESPACE, configKey, true);
    return created;
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

      // Sequential awaits (not batched) are deliberate here: the
      // `ensureTokenLayer`/`ensureSpanLayer` helpers below short-circuit when a
      // UD-flagged layer already exists, which makes a partial-failure re-run
      // safe (idempotent). Wrapping these in a batch would defeat that — we
      // need the in-memory result of each ensure-check to decide the next op.
      // The trade-off (no per-step atomicity) is acceptable because re-running
      // this form picks up where it left off.
      //
      // 1. Text layer
      let textLayerId = formData.selectedTextLayerId;
      let existingTextLayer = availableTextLayers.find(l => l.id === textLayerId) || null;
      if (formData.textLayerType === 'new') {
        const name = formData.newTextLayerName.trim() || 'Text';
        const textLayer = await client.textLayers.create(projectId, name);
        textLayerId = textLayer.id;
        existingTextLayer = null;
      }
      await client.textLayers.setConfig(textLayerId, UD_NAMESPACE, UD_TEXT_CONFIG_KEY, true);

      // 2. Token-layer hierarchy: sentences (partitioning) > words (non-overlapping) > morphemes (any)
      const sentenceLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.sentence, 'Sentences', 'partitioning', undefined
      );
      const wordLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.word, 'Words', 'non-overlapping', sentenceLayer.id
      );
      const morphemeLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.morpheme, 'Morphemes', 'any', wordLayer.id
      );

      // 3. Annotation span layers, all under the morpheme layer
      const existingMorphemeLayer = findFlagged(existingTextLayer?.tokenLayers, UD_NAMESPACE, UD_TOKEN_CONFIG_KEYS.morpheme);
      const spanLayers = {};
      for (const key of SPAN_KEYS_IN_ORDER) {
        spanLayers[key] = await ensureSpanLayer(
          client, morphemeLayer.id, existingMorphemeLayer, UD_SPAN_CONFIG_KEYS[key], SPAN_LAYER_NAMES[key]
        );
      }

      // 4. Dependency relation layer under the lemma span layer
      const existingRelationLayer = findFlagged(spanLayers.lemma?.relationLayers, UD_NAMESPACE, UD_RELATION_CONFIG_KEY);
      if (!existingRelationLayer) {
        const relationLayer = await client.relationLayers.create(spanLayers.lemma.id, 'Dependency Relations');
        await client.relationLayers.setConfig(relationLayer.id, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      }

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
  const missingLabels = info.missingLayers?.length
    ? info.missingLayers.map(key => UD_LAYER_LABELS[key] || key).join(', ')
    : '';

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Configure UD Layers</h1>
          <p className="text-gray-600 mt-1">Project: {project.name}</p>
          {info.isConfigured ? (
            <p className="text-sm text-green-600 mt-2">All Universal Dependencies layers are configured.</p>
          ) : (
            missingLabels && (
              <p className="text-sm text-amber-600 mt-2">Missing configuration detected for: {missingLabels}</p>
            )
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
                  onChange={() => setFormData(prev => ({ ...prev, textLayerType: 'existing' }))}
                  disabled={availableTextLayers.length === 0}
                />
                Use existing
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  className="text-blue-600 focus:ring-blue-500"
                  checked={formData.textLayerType === 'new'}
                  onChange={() => setFormData(prev => ({ ...prev, textLayerType: 'new' }))}
                />
                Create new
              </label>
            </div>

            {formData.textLayerType === 'existing' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select text layer</label>
                <select
                  value={formData.selectedTextLayerId}
                  onChange={(e) => setFormData(prev => ({ ...prev, selectedTextLayerId: e.target.value }))}
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
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Token Hierarchy &amp; Annotations</h2>
          <p className="text-sm text-gray-600 mb-4">
            Saving creates (or completes) the three-layer token hierarchy and the annotation layers below.
            Existing UD-flagged layers are reused, so this is safe to re-run.
          </p>
          <ul className="text-sm text-gray-700 space-y-1 ml-4 list-disc">
            <li><span className="font-medium">Sentences</span> token layer (partitioning)</li>
            <li><span className="font-medium">Words</span> token layer (non-overlapping, nested in sentences)</li>
            <li><span className="font-medium">Morphemes</span> token layer (overlap allowed, nested in words)</li>
            <li>Span layers on morphemes: Form, Lemma, UPOS, XPOS, Features</li>
            <li>Dependency relation layer on the Lemma layer</li>
          </ul>
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
