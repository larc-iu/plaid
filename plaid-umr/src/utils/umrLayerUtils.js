import { ROLES, findByRole, readRole } from '@larc-iu/plaid-client';

// The app's private config namespace. Substrate layers (text, sentences,
// words, morphemes) are found by their shared `config.plaid.role`; everything
// UMR itself owns is flagged under `config.umr`.
export const UMR_NAMESPACE = 'umr';

// Flags on the layers UMR owns.
//
//   Text (role baseline)
//   ├─ Sentences (role sentence)          shared substrate
//   │  └─ Words (role word)               shared substrate
//   │     └─ Morphemes (role morpheme)    IGT's, read when present
//   └─ UMR nodes (umr.nodes)              ROOT token layer, overlap-mode any:
//      │                                   one token per contiguous anchor
//      │                                   piece, zero-width when unaligned
//      └─ UMR concepts (umr.concepts)     span layer, one span per graph node
//         ├─ UMR relations (umr.relations)          sentence-level edges
//         └─ UMR document graph (umr.documentGraph) temporal, modal, coref
//
// The node layer is a root layer rather than a child of Words because core
// refuses zero-width tokens on a nested layer, and an unaligned concept
// (`person`, `author`, a `-91` roleset) is one. See docs/umr/DESIGN.md.
export const UMR_LAYER_FLAGS = {
  nodes: 'nodes',
  concepts: 'concepts',
  relations: 'relations',
  documentGraph: 'documentGraph',
};

export const UMR_LAYER_LABELS = {
  textLayer: 'Text layer',
  sentenceTokenLayer: 'Sentence layer',
  wordTokenLayer: 'Word layer',
  nodeTokenLayer: 'UMR node layer',
  conceptLayer: 'UMR concept layer',
  relationLayer: 'UMR relation layer',
  documentGraphLayer: 'UMR document graph layer',
};

const REQUIRED = [
  'textLayer',
  'sentenceTokenLayer',
  'wordTokenLayer',
  'nodeTokenLayer',
  'conceptLayer',
  'relationLayer',
  'documentGraphLayer',
];

const hasFlag = (layer, flag) => layer?.config?.[UMR_NAMESPACE]?.[flag] === true;

// The baseline text layer: the one tagged `baseline`, else the first.
const findTextLayer = (document) => {
  const layers = document?.textLayers || [];
  return findByRole(layers, ROLES.BASELINE) || layers[0] || null;
};

const findTokenLayerByRole = (textLayer, role) => findByRole(textLayer?.tokenLayers, role);

const findFlagged = (layers, flag) => (layers || []).find((l) => hasFlag(l, flag)) || null;

// Another app's annotation layers on the substrate, which the gloss lines
// can read: IGT's fields say their scope (`config.igt.scope`, Word,
// Morpheme or Sentence) and writing system (`config.igt.lang`); a layer that
// says nothing takes the scope of the token layer it hangs off.
const glossLayersOf = (sentenceLayer, wordLayer, morphemeLayer) => {
  const out = [];
  const take = (tokenLayer, scope) => {
    (tokenLayer?.spanLayers || []).forEach((layer) => {
      if (layer.config?.[UMR_NAMESPACE]) return;
      const igt = layer.config?.igt || {};
      const declared = String(igt.scope || '').toLowerCase();
      const s = declared === 'token' ? 'word' : declared || scope;
      out.push({ layer, scope: s, lang: igt.lang || null });
    });
  };
  take(sentenceLayer, 'sentence');
  take(wordLayer, 'word');
  take(morphemeLayer, 'morpheme');
  return out;
};

const EMPTY = Object.freeze({
  textLayer: null,
  sentenceTokenLayer: null,
  wordTokenLayer: null,
  morphemeTokenLayer: null,
  nodeTokenLayer: null,
  conceptLayer: null,
  relationLayer: null,
  documentGraphLayer: null,
  glossLayers: [],
  missingLayers: REQUIRED,
  isConfigured: false,
});

// The single resolver every screen calls. Takes a project or a document (both
// carry `textLayers` with the layer tree), null mid-load.
export const getUmrLayerInfo = (document) => {
  if (!document) return EMPTY;
  const textLayer = findTextLayer(document);
  const sentenceTokenLayer = findTokenLayerByRole(textLayer, ROLES.SENTENCE);
  const wordTokenLayer = findTokenLayerByRole(textLayer, ROLES.WORD);
  // IGT's, when the project has one. Never required, never created here.
  const morphemeTokenLayer = findTokenLayerByRole(textLayer, ROLES.MORPHEME);
  const nodeTokenLayer = findFlagged(textLayer?.tokenLayers, UMR_LAYER_FLAGS.nodes);
  const conceptLayer = findFlagged(nodeTokenLayer?.spanLayers, UMR_LAYER_FLAGS.concepts);
  const relationLayer = findFlagged(conceptLayer?.relationLayers, UMR_LAYER_FLAGS.relations);
  const documentGraphLayer = findFlagged(
    conceptLayer?.relationLayers,
    UMR_LAYER_FLAGS.documentGraph,
  );
  const info = {
    textLayer,
    sentenceTokenLayer,
    wordTokenLayer,
    morphemeTokenLayer,
    nodeTokenLayer,
    conceptLayer,
    relationLayer,
    documentGraphLayer,
    glossLayers: glossLayersOf(sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer),
  };
  const missingLayers = REQUIRED.filter((key) => !info[key]);
  return { ...info, missingLayers, isConfigured: missingLayers.length === 0 };
};

export const missingUmrLayerLabels = (missingKeys) =>
  (Array.isArray(missingKeys) ? missingKeys : []).map((key) => UMR_LAYER_LABELS[key] || key);

// Token layers UMR binds or owns. Any other role under the baseline means
// another app shares this substrate (IGT's morphemes, a time alignment).
const UMR_TOKEN_ROLES = new Set([ROLES.SENTENCE, ROLES.WORD, ROLES.MORPHEME]);

export const hasForeignSubstrateParticipants = (layerInfo) =>
  (layerInfo?.textLayer?.tokenLayers || []).some((tk) => {
    const role = readRole(tk.config);
    return role && !UMR_TOKEN_ROLES.has(role);
  });

// The project's language as a BCP-47 tag, from the project's own config. It
// picks the bundled frame file and the ISO code on exported gloss headers.
export const readProjectLanguage = (project) => {
  const tag = project?.config?.[UMR_NAMESPACE]?.language;
  return typeof tag === 'string' ? tag.trim() : '';
};

// The project's gloss-line mapping (see domain/ilg.js), or null when unset.
export const readIlgConfig = (project) => {
  const list = project?.config?.[UMR_NAMESPACE]?.ilg;
  return Array.isArray(list) ? list : null;
};
