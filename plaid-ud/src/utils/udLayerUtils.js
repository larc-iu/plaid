import {
  UPOS_TAGS, UNIVERSAL_DEPRELS, readVocab, readColorMap, readFeatureInventory
} from './udVocab.js';
import { ROLES, readRole } from '@larc-iu/plaid-client';

const UD_NAMESPACE = 'ud';

// Half-open containment: a child is contained in a parent iff its range fits
// AND the parent has non-zero remaining extent at the child's begin. This
// excludes a zero-width child sitting exactly at `parent.end`, which would
// otherwise double-attach to both adjacent parents in a partitioning layer.
// Use this everywhere parent/child containment is computed.
export const containsToken = (parent, child) =>
  parent.begin <= child.begin && child.end <= parent.end && child.begin < parent.end;

export const UD_RELATION_CONFIG_KEY = 'dependency';

// The three token layers of the UD hierarchy, bound by their shared role:
// - sentences:  role `sentence`, overlap-mode "partitioning" (root) — tiles the text
// - words:      role `word`, overlap-mode "non-overlapping", parent = sentences — surface tokens
// - morphemes:  role `syntactic-word`, overlap-mode "any", parent = words — UD syntactic
//               words (annotations live here); a sibling of IGT's `morpheme` layer.

// Span layers, all attached to the MORPHEME token layer.
export const UD_SPAN_CONFIG_KEYS = {
  form: 'form',
  lemma: 'lemma',
  upos: 'upos',
  xpos: 'xpos',
  features: 'features'
};

export const UD_LAYER_LABELS = {
  textLayer: 'Text layer',
  sentenceTokenLayer: 'Sentence layer',
  wordTokenLayer: 'Word layer',
  morphemeTokenLayer: 'Morpheme layer',
  form: 'Form layer',
  lemma: 'Lemma layer',
  upos: 'UPOS layer',
  xpos: 'XPOS layer',
  features: 'Features layer',
  dependency: 'Dependency relation layer'
};

const hasConfigFlag = (config, key) => config?.[UD_NAMESPACE]?.[key] === true;

// Substrate layers (text + token layers) are bound by their shared ROLE
// (config.plaid.role), so a UD project and a project set up by another app
// resolve the same way. Annotation span / relation layers stay private to UD
// and are bound by the `ud` config flags (findUdSpanLayer/findUdRelationLayer).
const findUdTextLayer = (document) => {
  if (!document?.textLayers) return null;
  return document.textLayers.find(layer => readRole(layer.config) === ROLES.BASELINE) || null;
};

const findUdTokenLayerByRole = (textLayer, role) => {
  if (!textLayer?.tokenLayers) return null;
  return textLayer.tokenLayers.find(layer => readRole(layer.config) === role) || null;
};

const findUdSpanLayer = (tokenLayer, configKey) => {
  if (!tokenLayer?.spanLayers) return null;
  return tokenLayer.spanLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

const findUdRelationLayer = (spanLayer, configKey = UD_RELATION_CONFIG_KEY) => {
  if (!spanLayer?.relationLayers) return null;
  return spanLayer.relationLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

const EMPTY_MISSING = [
  'textLayer',
  'sentenceTokenLayer',
  'wordTokenLayer',
  'morphemeTokenLayer',
  'form',
  'lemma',
  'upos',
  'xpos',
  'features',
  'dependency'
];

export const getUdLayerInfo = (document) => {
  if (!document) {
    return {
      textLayer: null,
      sentenceTokenLayer: null,
      wordTokenLayer: null,
      morphemeTokenLayer: null,
      tokenLayer: null,
      spanLayers: [],
      formLayer: null,
      lemmaLayer: null,
      uposLayer: null,
      xposLayer: null,
      featuresLayer: null,
      relationLayer: null,
      vocab: {
        upos: UPOS_TAGS,
        xpos: [],
        deprel: UNIVERSAL_DEPRELS,
        featureInventory: readFeatureInventory(null)
      },
      colors: { upos: {}, deprel: {} },
      missingLayers: [...EMPTY_MISSING],
      isConfigured: false
    };
  }

  const missingLayers = [];

  // Text layer
  const textLayer = findUdTextLayer(document);
  if (!textLayer) missingLayers.push('textLayer');

  // Token layers (sentences > words > morphemes), bound by shared role.
  const sentenceTokenLayer = findUdTokenLayerByRole(textLayer, ROLES.SENTENCE);
  if (!sentenceTokenLayer) missingLayers.push('sentenceTokenLayer');

  const wordTokenLayer = findUdTokenLayerByRole(textLayer, ROLES.WORD);
  if (!wordTokenLayer) missingLayers.push('wordTokenLayer');

  // UD's "Morphemes" token layer holds SYNTACTIC WORDS (CoNLL-U words / MWT
  // splits), so its shared role is `syntactic-word`, NOT `morpheme`.
  const morphemeTokenLayer = findUdTokenLayerByRole(textLayer, ROLES.SYNTACTIC_WORD);
  if (!morphemeTokenLayer) missingLayers.push('morphemeTokenLayer');

  // All annotation span layers hang off the morpheme token layer.
  const spanLayers = morphemeTokenLayer?.spanLayers || [];

  const formLayer = findUdSpanLayer(morphemeTokenLayer, UD_SPAN_CONFIG_KEYS.form);
  if (!formLayer) missingLayers.push('form');

  const lemmaLayer = findUdSpanLayer(morphemeTokenLayer, UD_SPAN_CONFIG_KEYS.lemma);
  if (!lemmaLayer) missingLayers.push('lemma');

  const uposLayer = findUdSpanLayer(morphemeTokenLayer, UD_SPAN_CONFIG_KEYS.upos);
  if (!uposLayer) missingLayers.push('upos');

  const xposLayer = findUdSpanLayer(morphemeTokenLayer, UD_SPAN_CONFIG_KEYS.xpos);
  if (!xposLayer) missingLayers.push('xpos');

  const featuresLayer = findUdSpanLayer(morphemeTokenLayer, UD_SPAN_CONFIG_KEYS.features);
  if (!featuresLayer) missingLayers.push('features');

  const relationLayer = lemmaLayer ? findUdRelationLayer(lemmaLayer) : null;
  if (!relationLayer) missingLayers.push('dependency');

  const normalizedMissing = Array.from(new Set(missingLayers));

  return {
    textLayer,
    sentenceTokenLayer,
    wordTokenLayer,
    morphemeTokenLayer,
    // Alias: annotations live under the morpheme layer, so consumers that look up
    // span layers under "the token layer" keep working unchanged.
    tokenLayer: morphemeTokenLayer,
    spanLayers,
    formLayer,
    lemmaLayer,
    uposLayer,
    xposLayer,
    featuresLayer,
    relationLayer,
    // Controlled vocabularies + color maps, parsed from each layer's `.config`.
    // UPOS is the fixed universal set; DEPREL falls back to the universal 37.
    // Rides the per-version layerInfo cache, so identity is stable across renders.
    vocab: {
      // UPOS defaults to the universal 17 but is project-configurable like the rest.
      upos: readVocab(uposLayer?.config, { fallback: UPOS_TAGS }),
      xpos: readVocab(xposLayer?.config, { fallback: [] }),
      deprel: readVocab(relationLayer?.config, { fallback: UNIVERSAL_DEPRELS }),
      featureInventory: readFeatureInventory(featuresLayer?.config)
    },
    colors: {
      upos: readColorMap(uposLayer?.config),
      deprel: readColorMap(relationLayer?.config)
    },
    missingLayers: normalizedMissing,
    isConfigured: normalizedMissing.length === 0
  };
};

export const missingUdLayerLabels = (missingKeys) => {
  if (!Array.isArray(missingKeys)) return [];
  return missingKeys.map(key => UD_LAYER_LABELS[key] || key);
};

export { UD_NAMESPACE };
