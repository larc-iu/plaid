const UD_NAMESPACE = 'ud';

export const UD_TEXT_CONFIG_KEY = 'textLayer';
export const UD_TOKEN_CONFIG_KEY = 'tokenLayer';
export const UD_RELATION_CONFIG_KEY = 'dependency';

export const UD_SPAN_CONFIG_KEYS = {
  lemma: 'lemma',
  upos: 'upos',
  xpos: 'xpos',
  features: 'features',
  sentence: 'sentence',
  mwt: 'mwt'
};

export const UD_LAYER_LABELS = {
  textLayer: 'Text layer',
  tokenLayer: 'Token layer',
  lemma: 'Lemma layer',
  upos: 'UPOS layer',
  xpos: 'XPOS layer',
  features: 'Features layer',
  sentence: 'Sentence layer',
  mwt: 'Multi-word token layer',
  dependency: 'Dependency relation layer'
};

const hasConfigFlag = (config, key) => config?.[UD_NAMESPACE]?.[key] === true;

export const findUdTextLayer = (document) => {
  if (!document?.textLayers) return null;
  return document.textLayers.find(layer => hasConfigFlag(layer.config, UD_TEXT_CONFIG_KEY)) || null;
};

export const findUdTokenLayer = (textLayer) => {
  if (!textLayer?.tokenLayers) return null;
  return textLayer.tokenLayers.find(layer => hasConfigFlag(layer.config, UD_TOKEN_CONFIG_KEY)) || null;
};

export const findUdSpanLayer = (tokenLayer, configKey) => {
  if (!tokenLayer?.spanLayers) return null;
  return tokenLayer.spanLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

export const findUdRelationLayer = (spanLayer, configKey = UD_RELATION_CONFIG_KEY) => {
  if (!spanLayer?.relationLayers) return null;
  return spanLayer.relationLayers.find(layer => hasConfigFlag(layer.config, configKey)) || null;
};

export const getUdLayerInfo = (document) => {
  if (!document) {
    return {
      textLayer: null,
      tokenLayer: null,
      spanLayers: [],
      lemmaLayer: null,
      uposLayer: null,
      xposLayer: null,
      featuresLayer: null,
      sentenceLayer: null,
      mwtLayer: null,
      relationLayer: null,
      missingLayers: [
        'textLayer',
        'tokenLayer',
        'lemma',
        'upos',
        'xpos',
        'features',
        'sentence',
        'mwt',
        'dependency'
      ],
      isConfigured: false
    };
  }

  const missingLayers = [];

  // Text layer detection
  const textLayerConfigured = findUdTextLayer(document);
  const textLayer = textLayerConfigured || document.textLayers?.[0] || null;
  if (!textLayer || !textLayerConfigured) {
    missingLayers.push('textLayer');
  }

  // Token layer detection
  const tokenLayerConfigured = findUdTokenLayer(textLayer);
  const tokenLayer = tokenLayerConfigured || textLayer?.tokenLayers?.[0] || null;
  if (!tokenLayer || !tokenLayerConfigured) {
    missingLayers.push('tokenLayer');
  }

  const spanLayers = tokenLayer?.spanLayers || [];

  const lemmaLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.lemma);
  if (!lemmaLayer) missingLayers.push('lemma');

  const uposLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.upos);
  if (!uposLayer) missingLayers.push('upos');

  const xposLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.xpos);
  if (!xposLayer) missingLayers.push('xpos');

  const featuresLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.features);
  if (!featuresLayer) missingLayers.push('features');

  const sentenceLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.sentence);
  if (!sentenceLayer) missingLayers.push('sentence');

  const mwtLayer = findUdSpanLayer(tokenLayer, UD_SPAN_CONFIG_KEYS.mwt);
  if (!mwtLayer) missingLayers.push('mwt');

  const relationLayer = lemmaLayer ? findUdRelationLayer(lemmaLayer) : null;
  if (!relationLayer) missingLayers.push('dependency');

  const normalizedMissing = Array.from(new Set(missingLayers));

  return {
    textLayer,
    tokenLayer,
    spanLayers,
    lemmaLayer,
    uposLayer,
    xposLayer,
    featuresLayer,
    sentenceLayer,
    mwtLayer,
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
