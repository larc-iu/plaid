import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo } from '../../utils/udLayerUtils.js';
import {
  UPOS_TAGS,
  UNIVERSAL_DEPRELS,
  autoColor,
  cleanColorMap,
  baseRel,
} from '../../utils/udVocab.js';
import {
  readMetadataFields,
  toMetadataConfig,
  metadataFieldError,
  DOCUMENT_METADATA_KEY,
  SENTENCE_METADATA_KEY,
} from '../../utils/udMetadata.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { expectStored, isConfigConflict, sameConfig } from '@ui/domain/configCells.js';
import { RotateCcw, Trash2 } from 'lucide-react';
import { TagList } from '../common/TagList.jsx';
import { MetadataFieldList } from '../common/MetadataFieldList.jsx';
import { VocabModeSwitch } from '../common/VocabModeSwitch.jsx';
import { DescriptionList } from '../common/DescriptionList.jsx';
import { MODES, cleanDescriptions } from '../../utils/udVocabMode.js';
import { queueRuleChanges, withConfigWrites } from '../../utils/udConstraints.js';
import { UPOS_DESCRIPTIONS, DEPREL_DESCRIPTIONS } from '../../utils/udVocabDescriptions.js';
import { ColorField } from '../common/ColorField.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { ROW_DELETE_CLASS } from '@ui/lib/destructive.js';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// What the tab shows for a project, read from its layer and project config.
const seedFrom = (project) => {
  const info = getUdLayerInfo(project);
  return {
    uposVocab: info.vocab.upos || [],
    xposVocab: info.vocab.xpos || [],
    deprelVocab: info.vocab.deprel || [],
    deprelColors: info.colors.deprel || {},
    uposColors: info.colors.upos || {},
    featureInventory: info.vocab.featureInventory.list.map((e) => ({
      key: e.key,
      values: [...e.values],
    })),
    modes: { ...info.modes },
    descriptions: {
      upos: { ...info.descriptions.upos },
      xpos: { ...info.descriptions.xpos },
      deprel: { ...info.descriptions.deprel },
      feats: { ...info.descriptions.feats },
    },
    // These two are on the PROJECT, not on a layer: they describe the document
    // and the sentence, neither of which belongs to an annotation layer.
    documentFields: readMetadataFields(project.config, 'document'),
    sentenceFields: readMetadataFields(project.config, 'sentence'),
  };
};

// The tab's state as one comparable value, its keys in one fixed order.
// Colours and descriptions go through the cleaning Save applies, so a field
// typed into and cleared again is no change.
const snapshot = (state) =>
  JSON.stringify({
    uposVocab: state.uposVocab,
    xposVocab: state.xposVocab,
    deprelVocab: state.deprelVocab,
    featureInventory: state.featureInventory,
    modes: state.modes,
    documentFields: state.documentFields,
    sentenceFields: state.sentenceFields,
    deprelColors: cleanColorMap(state.deprelColors),
    uposColors: cleanColorMap(state.uposColors),
    descriptions: Object.fromEntries(
      Object.entries(state.descriptions).map(([k, v]) => [k, cleanDescriptions(v || {})]),
    ),
  });

// The tab's settings one at a time, each with the card it is on. A Save that
// another maintainer's save refused (409) reads the project again, and only
// the settings changed there take the new value. Every other change on the
// tab stays as it was typed.
const VOCAB_CARDS = {
  upos: 'UPOS tags',
  xpos: 'XPOS tags',
  deprel: 'Dependency relations',
  feats: 'Feature inventory',
};
const SETTINGS = [
  ['uposVocab', 'UPOS tags'],
  ['xposVocab', 'XPOS tags'],
  ['deprelVocab', 'Dependency relations'],
  ['deprelColors', 'Relation colors'],
  ['uposColors', 'UPOS colors'],
  ['featureInventory', 'Feature inventory'],
  ['documentFields', 'Document fields'],
  ['sentenceFields', 'Sentence fields'],
  ...['modes', 'descriptions'].flatMap((head) =>
    Object.entries(VOCAB_CARDS).map(([vocab, card]) => [`${head}.${vocab}`, card]),
  ),
];

// One setting of a tab state, cleaned as Save cleans it.
const settingValue = (state, path) => {
  const [head, vocab] = path.split('.');
  const value = vocab ? state[head]?.[vocab] : state[head];
  if (head === 'modes') return value || MODES.OPEN;
  if (head === 'descriptions') return cleanDescriptions(value || {});
  if (head.endsWith('Colors')) return cleanColorMap(value || {});
  return value;
};
const sameSetting = (a, b, path) => sameConfig(settingValue(a, path), settingValue(b, path));

// The cards whose change on the tab gave way to a different change saved
// elsewhere, and whether the tab still holds changes of its own.
const conflictSummary = (draft, loaded, latest) => {
  const edited = SETTINGS.filter(([path]) => !sameSetting(draft, loaded, path));
  const movedThere = ([path]) => !sameSetting(loaded, latest, path);
  const replaced = edited.filter((s) => movedThere(s) && !sameSetting(draft, latest, s[0]));
  return {
    replaced: [...new Set(replaced.map(([, card]) => card))],
    kept: edited.some((s) => !movedThere(s)),
  };
};

const conflictMessage = ({ replaced, kept }) => {
  const latest = replaced.length
    ? `Changed elsewhere, now showing the latest: ${replaced.join(', ')}.`
    : 'Changed elsewhere.';
  return kept ? `${latest} Save again for the rest.` : latest;
};

// Every config cell this tab writes, with the value the tab's state stores
// there. Mode and descriptions are SIBLING keys beside `vocab`, never a new
// shape for it: see utils/udVocabMode.js. Descriptions are stored only where
// they differ from what ships, so a project that never edited them stores
// nothing and follows the app's copy.
const configCells = (state, info, project) => {
  const storedDescriptions = (map, shipped) =>
    cleanDescriptions(
      Object.fromEntries(
        Object.entries(map || {}).filter(([value, text]) => text !== (shipped?.[value] ?? '')),
      ),
    );
  const cells = [];
  const add = (bundle, entity, key, value) =>
    entity && cells.push({ id: `${entity.id}/${key}`, bundle, entity, key, value });
  const { modes, descriptions } = state;

  add('spanLayers', info.xposLayer, 'vocab', state.xposVocab);
  add('spanLayers', info.xposLayer, 'vocabMode', modes.xpos || MODES.OPEN);
  add('spanLayers', info.xposLayer, 'vocabDescriptions', storedDescriptions(descriptions.xpos));

  add('relationLayers', info.relationLayer, 'vocab', state.deprelVocab);
  add('relationLayers', info.relationLayer, 'colors', cleanColorMap(state.deprelColors));
  add('relationLayers', info.relationLayer, 'vocabMode', modes.deprel || MODES.OPEN);
  add(
    'relationLayers',
    info.relationLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.deprel, DEPREL_DESCRIPTIONS),
  );

  add('spanLayers', info.uposLayer, 'vocab', state.uposVocab);
  add('spanLayers', info.uposLayer, 'colors', cleanColorMap(state.uposColors));
  add('spanLayers', info.uposLayer, 'vocabMode', modes.upos || MODES.OPEN);
  add(
    'spanLayers',
    info.uposLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.upos, UPOS_DESCRIPTIONS),
  );

  const inventory = state.featureInventory
    .filter((e) => e.key.trim())
    .map((e) => ({
      key: e.key.trim(),
      values: (e.values || []).map((v) => v.trim()).filter(Boolean),
    }));
  add('spanLayers', info.featuresLayer, 'inventory', inventory);
  add('spanLayers', info.featuresLayer, 'vocabMode', modes.feats || MODES.OPEN);
  add(
    'spanLayers',
    info.featuresLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.feats),
  );

  add('projects', project, DOCUMENT_METADATA_KEY, toMetadataConfig(state.documentFields));
  add('projects', project, SENTENCE_METADATA_KEY, toMetadataConfig(state.sentenceFields));
  return cells;
};

// "UD settings" section: project-specific controlled vocabularies, colors, and
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

  // A FEATS description belongs to the whole `Key=Value` pair, because that is
  // what a span stores and what the picker offers. A key with no values listed
  // accepts anything, so there is no pair to describe and none is offered.
  const featurePairs = useMemo(
    () =>
      featureInventory.flatMap((entry) =>
        entry.key.trim() ? (entry.values || []).map((v) => `${entry.key.trim()}=${v}`) : [],
      ),
    [featureInventory],
  );
  const [documentFields, setDocumentFields] = useState([]); // field names
  const [sentenceFields, setSentenceFields] = useState([]); // field names
  // Whether each vocabulary refuses off-list values, and the one-line
  // definitions shown beside a value in the picker.
  const [modes, setModes] = useState({});
  const [descriptions, setDescriptions] = useState({ upos: {}, xpos: {}, deprel: {}, feats: {} });

  // Save waits until something on the tab differs from what the project has.
  const baseline = useMemo(() => (project ? snapshot(seedFrom(project)) : null), [project]);
  const dirty =
    baseline !== null &&
    snapshot({
      uposVocab,
      xposVocab,
      deprelVocab,
      deprelColors,
      uposColors,
      featureInventory,
      documentFields,
      sentenceFields,
      modes,
      descriptions,
    }) !== baseline;

  // Leaving the tab, the page or the window with a change made asks first.
  useUnsavedDraft(dirty ? 'The settings you have changed' : null);

  // Seed the editors from the project's current layer config. A project read
  // again (after a Save, or after one refused because of a save elsewhere)
  // changes only the settings that changed on the server, so an edit to any
  // other setting survives the read.
  const seeded = useRef(null);
  useEffect(() => {
    if (!project) return;
    const seed = seedFrom(project);
    const before = seeded.current?.id === project.id ? seeded.current.seed : null;
    seeded.current = { id: project.id, seed };
    const moved = (path) => !before || !sameSetting(before, seed, path);
    const take = (head) => (prev) => (moved(head) ? seed[head] : prev);
    const takeEach = (head) => (prev) =>
      Object.fromEntries(
        Object.keys(VOCAB_CARDS).map((v) => [v, moved(`${head}.${v}`) ? seed[head][v] : prev[v]]),
      );
    setUposVocab(take('uposVocab'));
    setXposVocab(take('xposVocab'));
    setDeprelVocab(take('deprelVocab'));
    setDeprelColors(take('deprelColors'));
    setUposColors(take('uposColors'));
    setFeatureInventory(take('featureInventory'));
    setModes(takeEach('modes'));
    setDescriptions(takeEach('descriptions'));
    setDocumentFields(take('documentFields'));
    setSentenceFields(take('sentenceFields'));
  }, [project]);

  const setMode = (field) => (closed) =>
    setModes((prev) => ({ ...prev, [field]: closed ? MODES.CLOSED : MODES.OPEN }));

  const setDescription = (field) => (value, text) =>
    setDescriptions((prev) => ({ ...prev, [field]: { ...prev[field], [value]: text } }));

  // Set/clear a single color in a {label: '#hex'} map (clearing falls back to auto).
  const setColorIn = (setter) => (key, value) => {
    setter((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  // Save writes only the settings changed on this tab, in one batch, each
  // expecting the value the tab was loaded with. A save by someone else since
  // then refuses the batch (409), and the tab reads the project again and
  // keeps every change whose setting did not change there.
  const handleSave = async () => {
    setSaving(true);
    const current = {
      uposVocab,
      xposVocab,
      deprelVocab,
      deprelColors,
      uposColors,
      featureInventory,
      documentFields,
      sentenceFields,
      modes,
      descriptions,
    };
    const loadedSeed = seedFrom(project);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);
      const loaded = new Map(configCells(loadedSeed, info, project).map((c) => [c.id, c]));
      const changed = configCells(current, info, project).filter(
        (c) => !sameConfig(c.value, loaded.get(c.id)?.value),
      );
      // A closed list is a rule its layer holds on the server, so the layers
      // whose rules this save changes take them in the same batch, and a
      // list the stored values break is refused whole.
      const after = getUdLayerInfo(withConfigWrites(project, changed));
      await client.batched((b) => {
        for (const c of changed) {
          b[c.bundle].setConfig(
            c.entity.id,
            UD_NAMESPACE,
            c.key,
            c.value,
            undefined,
            expectStored(c.entity, UD_NAMESPACE, c.key),
          );
        }
        queueRuleChanges(b, info, after);
      });

      await fetchProject();
      notifySuccess('UD settings saved');
    } catch (err) {
      console.error('Failed to save customization:', err);
      if (isConfigConflict(err)) {
        // Reading the project again moves only what changed there (the seed
        // effect above). The toast names the cards where that replaced a
        // change made on this tab.
        const latest = await fetchProject();
        const summary = latest
          ? conflictSummary(current, loadedSeed, seedFrom(latest))
          : { replaced: [], kept: true };
        notifyError(conflictMessage(summary), 'UD settings not saved');
      } else {
        notifyError(err, 'Failed to save the UD settings');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Loading />;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);

  if (!info.isConfigured) {
    return (
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Set the project up for UD first.
      </p>
    );
  }

  const resetButton = (onClick, label) => (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <RotateCcw className="h-3.5 w-3.5" /> {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">UPOS tags</CardTitle>
          {resetButton(() => setUposVocab([...UPOS_TAGS]), 'Reset to universal 17')}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Part-of-speech tags offered while annotating. The 17 universal tags by default. Off-list
            values are accepted unless refused below. Imports and parsers may write values outside
            the list. The Validation tab lists what is off-list.
          </p>
          <TagList
            value={uposVocab}
            onChange={setUposVocab}
            label="UPOS tags"
            placeholder="Add a UPOS tag and press Enter"
          />
          <VocabModeSwitch
            id="upos-closed"
            noun="tags"
            closed={modes.upos === MODES.CLOSED}
            onChange={setMode('upos')}
          />
          <DescriptionList
            values={uposVocab}
            descriptions={descriptions.upos}
            onChange={setDescription('upos')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">XPOS tags</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Language-specific part-of-speech tags offered while annotating.
          </p>
          <TagList
            value={xposVocab}
            onChange={setXposVocab}
            label="XPOS tags"
            placeholder="Add an XPOS tag and press Enter"
          />
          <VocabModeSwitch
            id="xpos-closed"
            noun="tags"
            closed={modes.xpos === MODES.CLOSED}
            onChange={setMode('xpos')}
          />
          <DescriptionList
            values={xposVocab}
            descriptions={descriptions.xpos}
            onChange={setDescription('xpos')}
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
          <VocabModeSwitch
            id="deprel-closed"
            noun="relations"
            closed={modes.deprel === MODES.CLOSED}
            onChange={setMode('deprel')}
          />
          {modes.deprel === MODES.CLOSED && (
            <p className="text-xs text-muted-foreground">
              A subtype is judged by its base relation. <code>nsubj:pass</code> is allowed wherever{' '}
              <code>nsubj</code> is.
            </p>
          )}
          <DescriptionList
            values={deprelVocab}
            descriptions={descriptions.deprel}
            onChange={setDescription('deprel')}
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
                className={`h-9 w-9 shrink-0 ${ROW_DELETE_CLASS}`}
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
          <VocabModeSwitch
            id="feats-closed"
            noun="features"
            closed={modes.feats === MODES.CLOSED}
            onChange={setMode('feats')}
          />
          {modes.feats === MODES.CLOSED && (
            <p className="text-xs text-muted-foreground">
              Both the key and the value are checked. A key with no values listed accepts any value.
            </p>
          )}
          <DescriptionList
            values={featurePairs}
            descriptions={descriptions.feats}
            onChange={setDescription('feats')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Document fields</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Notes kept about each document as a whole, edited on its Details tab. A treebank usually
            records where a text came from and what it may be used for, as <code>source</code>,{' '}
            <code>genre</code> or <code>license</code>.
          </p>
          <MetadataFieldList
            value={documentFields}
            onChange={setDocumentFields}
            validate={(name, taken) => metadataFieldError(name, 'document', taken)}
            label="Document fields"
            placeholder="Add a field and press Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sentence fields</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Notes kept about each sentence, edited under the sentence in the Annotate view. Every
            sentence already carries <code>sent_id</code>. A free translation is usually{' '}
            <code>text_en</code>, naming the language it is in.
          </p>
          <MetadataFieldList
            value={sentenceFields}
            onChange={setSentenceFields}
            validate={(name, taken) => metadataFieldError(name, 'sentence', taken)}
            label="Sentence fields"
            placeholder="Add a field and press Enter"
          />
        </CardContent>
      </Card>

      {/* Held at the bottom of the window, so a change at the top of a long
          page has its Save in view. */}
      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t bg-background py-3">
        {dirty && !saving && <span className="text-sm text-muted-foreground">Not saved</span>}
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
};
