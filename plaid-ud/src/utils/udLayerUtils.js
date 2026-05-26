const UD_NAMESPACE = 'ud';

// Half-open containment: a child is contained in a parent iff its range fits
// AND the parent has non-zero remaining extent at the child's begin. This
// excludes a zero-width child sitting exactly at `parent.end`, which would
// otherwise double-attach to both adjacent parents in a partitioning layer.
// Use this everywhere parent/child containment is computed.
export const containsToken = (parent, child) =>
  parent.begin <= child.begin && child.end <= parent.end && child.begin < parent.end;

export const UD_TEXT_CONFIG_KEY = 'textLayer';
export const UD_RELATION_CONFIG_KEY = 'dependency';

// The three token layers of the UD hierarchy: sentences > words > morphemes.
// - sentences:  overlap-mode "partitioning" (root) — tile the whole text
// - words:      overlap-mode "non-overlapping", parent = sentences — UD surface tokens
// - morphemes:  overlap-mode "any", parent = words — UD syntactic words (annotations live here)
export const UD_TOKEN_CONFIG_KEYS = {
  sentence: 'sentenceTokenLayer',
  word: 'wordTokenLayer',
  morpheme: 'morphemeTokenLayer'
};

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

export const findUdTextLayer = (document) => {
  if (!document?.textLayers) return null;
  return document.textLayers.find(layer => hasConfigFlag(layer.config, UD_TEXT_CONFIG_KEY)) || null;
};

export const findUdTokenLayer = (textLayer, configKey) => {
  if (!textLayer?.tokenLayers) return null;
  return textLayer.tokenLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

export const findUdSpanLayer = (tokenLayer, configKey) => {
  if (!tokenLayer?.spanLayers) return null;
  return tokenLayer.spanLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

export const findUdRelationLayer = (spanLayer, configKey = UD_RELATION_CONFIG_KEY) => {
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
      missingLayers: [...EMPTY_MISSING],
      isConfigured: false
    };
  }

  const missingLayers = [];

  // Text layer
  const textLayer = findUdTextLayer(document);
  if (!textLayer) missingLayers.push('textLayer');

  // Token layers (sentences > words > morphemes)
  const sentenceTokenLayer = findUdTokenLayer(textLayer, UD_TOKEN_CONFIG_KEYS.sentence);
  if (!sentenceTokenLayer) missingLayers.push('sentenceTokenLayer');

  const wordTokenLayer = findUdTokenLayer(textLayer, UD_TOKEN_CONFIG_KEYS.word);
  if (!wordTokenLayer) missingLayers.push('wordTokenLayer');

  const morphemeTokenLayer = findUdTokenLayer(textLayer, UD_TOKEN_CONFIG_KEYS.morpheme);
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
    missingLayers: normalizedMissing,
    isConfigured: normalizedMissing.length === 0
  };
};

export const hasRequiredUdLayers = (document) => getUdLayerInfo(document).isConfigured;

export const missingUdLayerLabels = (missingKeys) => {
  if (!Array.isArray(missingKeys)) return [];
  return missingKeys.map(key => UD_LAYER_LABELS[key] || key);
};

export { UD_NAMESPACE };
