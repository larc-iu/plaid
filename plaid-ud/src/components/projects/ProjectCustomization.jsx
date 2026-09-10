import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo } from '../../utils/udLayerUtils.js';
import {
  UPOS_TAGS,
  UNIVERSAL_DEPRELS,
  autoColor,
  cleanColorMap,
  baseRel,
} from '../../utils/udVocab.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useManagedProject } from './useManagedProject.js';
import { RotateCcw, Trash2 } from 'lucide-react';
import { TagList } from '../common/TagList.jsx';
import { ColorField } from '../common/ColorField.jsx';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// "UD Customization" tab: project-specific controlled vocabularies, colors, and
// the feature inventory. Everything here is local state until you press Save —
// nothing round-trips on a keystroke. These settings attach to the UD annotation
// layers, so the project must be configured before they can be edited. (The
// tokenizer locale and project deletion live on the General tab.)
export const ProjectCustomization = () => {
  const { project, loading, fetchProject, canConfigure } = useManagedProject();
  const { getClient } = useAuth();

  const [saving, setSaving] = useState(false);

  const [uposVocab, setUposVocab] = useState([]);
  const [xposVocab, setXposVocab] = useState([]);
  const [deprelVocab, setDeprelVocab] = useState([]);
  const [deprelColors, setDeprelColors] = useState({}); // { baseRel: '#hex' }
  const [uposColors, setUposColors] = useState({}); // { UPOS: '#hex' }
  const [featureInventory, setFeatureInventory] = useState([]); // [{key, values}]

  // Seed the editors from the project's current layer config.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    setUposVocab(info.vocab.upos || []);
    setXposVocab(info.vocab.xpos || []);
    setDeprelVocab(info.vocab.deprel || []);
    setDeprelColors(info.colors.deprel || {});
    setUposColors(info.colors.upos || {});
    setFeatureInventory(
      info.vocab.featureInventory.list.map((e) => ({ key: e.key, values: [...e.values] })),
    );
  }, [project]);

  // Set/clear a single color in a {label: '#hex'} map (clearing falls back to auto).
  const setColorIn = (setter) => (key, value) => {
    setter((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  // Persist everything on this tab in one go. Each setConfig is a PUT (full
  // replace), so this is idempotent and safe to re-run.
  const handleSave = async () => {
    setSaving(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);

      if (info.xposLayer) {
        await client.spanLayers.setConfig(info.xposLayer.id, UD_NAMESPACE, 'vocab', xposVocab);
      }
      if (info.relationLayer) {
        await client.relationLayers.setConfig(
          info.relationLayer.id,
          UD_NAMESPACE,
          'vocab',
          deprelVocab,
        );
        await client.relationLayers.setConfig(
          info.relationLayer.id,
          UD_NAMESPACE,
          'colors',
          cleanColorMap(deprelColors),
        );
      }
      if (info.uposLayer) {
        await client.spanLayers.setConfig(info.uposLayer.id, UD_NAMESPACE, 'vocab', uposVocab);
        await client.spanLayers.setConfig(
          info.uposLayer.id,
          UD_NAMESPACE,
          'colors',
          cleanColorMap(uposColors),
        );
      }
      if (info.featuresLayer) {
        const inventory = featureInventory
          .filter((e) => e.key.trim())
          .map((e) => ({
            key: e.key.trim(),
            values: (e.values || []).map((v) => v.trim()).filter(Boolean),
          }));
        await client.spanLayers.setConfig(
          info.featuresLayer.id,
          UD_NAMESPACE,
          'inventory',
          inventory,
        );
      }

      await fetchProject();
      notifySuccess('Customization saved');
    } catch (err) {
      console.error('Failed to save customization:', err);
      notifyError(err.message || 'Failed to save customization.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="tw p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);

  if (!info.isConfigured) {
    return (
      <p className="tw rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Set up the project&apos;s UD layers first. Vocabulary and color settings attach to those
        annotation layers.
      </p>
    );
  }

  const resetButton = (onClick, label) => (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <RotateCcw className="h-3.5 w-3.5" /> {label}
    </Button>
  );

  return (
    <div className="tw flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">UPOS tags</CardTitle>
          {resetButton(() => setUposVocab([...UPOS_TAGS]), 'Reset to universal 17')}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Universal part-of-speech tags suggested while annotating. Defaults to the 17 universal
            tags; edit them for project-specific needs. Annotators may still type values outside
            this list.
          </p>
          <TagList
            value={uposVocab}
            onChange={setUposVocab}
            label="UPOS tags"
            placeholder="Add a UPOS tag and press Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">XPOS tags</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Language-specific part-of-speech tags suggested while annotating. Annotators may still
            type values outside this list.
          </p>
          <TagList
            value={xposVocab}
            onChange={setXposVocab}
            label="XPOS tags"
            placeholder="Add an XPOS tag and press Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Dependency relations</CardTitle>
          {resetButton(() => setDeprelVocab([...UNIVERSAL_DEPRELS]), 'Reset to universal 37')}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Relations suggested when labeling edges. Subtypes (e.g. <code>nsubj:pass</code>) are
            allowed.
          </p>
          <TagList
            value={deprelVocab}
            onChange={setDeprelVocab}
            label="Dependency relations"
            placeholder="Add a relation and press Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Relation colors</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Dependency edges are colored by their base relation. Each shows its current color, an
            automatic one by default. Pick a color to override, or empty the field to go back to
            automatic.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[...new Set(deprelVocab.map(baseRel))].sort().map((rel) => (
              <ColorField
                key={rel}
                label={rel}
                value={deprelColors[rel] || autoColor(rel)}
                onChange={(v) => setColorIn(setDeprelColors)(rel, v)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">UPOS colors</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            The UPOS tags above, colored in the annotation grid. Each shows its current color. Pick
            one to override, or empty the field to go back to automatic.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[...new Set(uposVocab)].map((tag) => (
              <ColorField
                key={tag}
                label={tag}
                value={uposColors[tag] || autoColor(tag)}
                onChange={(v) => setColorIn(setUposColors)(tag, v)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Feature inventory</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Feature names and values offered in the FEATS picker. New keys and values are still
            allowed while annotating.
          </p>
          {featureInventory.map((entry, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border p-3">
              <Input
                className="w-40 shrink-0"
                spellCheck={false}
                value={entry.key}
                placeholder="e.g. Number"
                aria-label="Feature name"
                onChange={(e) =>
                  setFeatureInventory((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <TagList
                  value={entry.values}
                  label={`${entry.key || 'Feature'} values`}
                  placeholder="Add a value and press Enter"
                  onChange={(vals) =>
                    setFeatureInventory((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, values: vals } : x)),
                    )
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-destructive"
                aria-label={`Remove ${entry.key || 'feature'}`}
                onClick={() => setFeatureInventory((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setFeatureInventory((prev) => [...prev, { key: '', values: [] }])}
          >
            Add feature
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save customization'}
        </Button>
      </div>
    </div>
  );
};
