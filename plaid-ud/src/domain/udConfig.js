// plaid-ud's half of a project's config: the namespace, the keys it stores
// there, and the readers of the values that are not a vocabulary's.
//
// Layers and the project keep UD's settings under `config.ud`. Every reader
// and writer in the app names the namespace through UD_NAMESPACE, and a raw
// value through readUdConfig, so a new key has one home and the namespace is
// written once. The vocabulary readers (udVocab.js, udVocabMode.js) read
// through readUdConfig and keep the defaults they fall back on beside them.

export const UD_NAMESPACE = 'ud';

// The flags that mark UD's own annotation layers (a span layer's `form`,
// `lemma`, ..., the tree's `dependency`). Substrate layers are found by role,
// not by these (udLayerUtils.js).
export const UD_SPAN_CONFIG_KEYS = {
  form: 'form',
  lemma: 'lemma',
  upos: 'upos',
  xpos: 'xpos',
  features: 'features',
};

export const UD_RELATION_CONFIG_KEY = 'dependency';

// The second relation layer on Lemma, holding what the enhanced graph has that
// the basic tree does not (see domain/enhancedGraph.js). Every UD project has
// one: a project without it is not set up for UD. It carries its own flag and
// not the
// `dependency` one, so everything that finds the tree by that flag, in this app
// and outside it, goes on finding the tree alone.
export const UD_ENHANCED_RELATION_CONFIG_KEY = 'enhancedDependency';

// The project's declared metadata fields, one list per level (udMetadata.js).
export const DOCUMENT_METADATA_KEY = 'documentMetadata';
export const SENTENCE_METADATA_KEY = 'sentenceMetadata';

// The text layer's segmenter locale (General settings).
export const TOKENIZER_LOCALE_KEY = 'tokenizerLocale';

/** The raw value stored at `config.ud[key]`, or undefined. */
export const readUdConfig = (config, key) => config?.[UD_NAMESPACE]?.[key];

/** Whether `config.ud[key]` is the flag `true`. */
export const hasUdFlag = (config, key) => readUdConfig(config, key) === true;

// The one language a UD project annotates, as a BCP-47 tag, from the PROJECT's
// own config (`config.ud.language`): not a layer's. It is the fallback for the
// tokenizer locale and the seed for a parse service's `language` argument.
// '' when unset.
export const readProjectLanguage = (project) => {
  const tag = readUdConfig(project?.config, 'language');
  return typeof tag === 'string' ? tag.trim() : '';
};

/** The locale stored on the text layer itself, '' when none is. */
export const readStoredTokenizerLocale = (textLayer) =>
  readUdConfig(textLayer?.config, TOKENIZER_LOCALE_KEY) || '';

// The locale the segmenter runs with. Locale drives Intl.Segmenter's
// script-specific word segmentation (esp. ja/zh/th dictionary lookup). The
// text layer's own locale wins, since it can carry a script subtag the project
// language does not (zh-Hans), otherwise the project's language stands in,
// and 'und' last.
export const readTokenizerLocale = (textLayer, project) =>
  readStoredTokenizerLocale(textLayer) || readProjectLanguage(project) || 'und';

/** The declared field names for a level, in the order the project set. */
export function readMetadataFields(config, level) {
  const key = level === 'sentence' ? SENTENCE_METADATA_KEY : DOCUMENT_METADATA_KEY;
  const raw = readUdConfig(config, key);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((field) => (typeof field === 'string' ? field : field?.name))
    .filter((name) => typeof name === 'string' && name.trim() !== '');
}
