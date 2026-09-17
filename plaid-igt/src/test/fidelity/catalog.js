// Everything an IGT project can hold, as a list of features a fidelity check
// can name.
//
// Each feature has a stable `key`, a sentence saying what it is, and `detect`,
// which counts it in one project snapshot (e2e/fidelity/snapshot.mjs). Three
// things lean on this list:
//
//   - the kitchen-sink builder (e2e/fidelity/kitchenSink.mjs) has to make every
//     feature appear at least once, and the coverage run fails when one does
//     not, so a feature nobody seeds cannot be quietly untested;
//   - every format's loss list (./formats/) has to say, for every key, whether
//     that format carries it, and fidelity.test.js fails on a key a format has
//     not been asked about;
//   - a round-trip comparison attributes each difference it finds to a key,
//     and a difference on a key the format says it carries is a bug.
//
// A feature is `foreign` when plaid-igt never writes it, but another app
// sharing the project does (plaid-ud's relations, dig4el's unscoped fields).
// No IGT format is expected to carry those. They are here so that an importer
// or exporter meeting them is exercised rather than assumed to cope.
//
// `bare` marks a feature the project setup wizard creates on its own, which
// the negative control (a project with nothing but setup in it) is allowed to
// show. Every other detector must count zero there, which is what catches a
// detector that is true of everything.

import { provState } from '@larc-iu/plaid-client';
import { CORE_VOCAB_FIELDS, RESERVED_ITEM_KEYS } from '../../domain/vocabFields.js';

// ---- snapshot helpers ---------------------------------------------------------

const docs = (s) => s.documents || [];
const sum = (s, f) => docs(s).reduce((n, d) => n + f(d), 0);
const count = (arr, pred) => (arr || []).filter(pred).length;
const layer = (s, key) => (s.layers || []).find((l) => l.key === key);
const tokensIn = (d, role) => d.tokens.filter((t) => t.layer === `token:${role}`);
const spanLayers = (s) => (s.layers || []).filter((l) => l.key.startsWith('span:'));
const scopeOf = (s, spanLayerKey) => layer(s, spanLayerKey)?.config?.igt?.scope ?? null;
const igt = (s) => s.config?.igt || {};
const nonEmptyObject = (v) => !!v && typeof v === 'object' && Object.keys(v).length > 0;
const tagsets = (s) => Object.values(igt(s).tagsets || {});
const vocabs = (s) => s.vocabularies || [];
const items = (s) => vocabs(s).flatMap((v) => v.items || []);
const allLinks = (s) => docs(s).flatMap((d) => d.links);
const allSpans = (s) => docs(s).flatMap((d) => d.spans);
const allComments = (s) => [
  ...docs(s).flatMap((d) => d.comments),
  ...vocabs(s).flatMap((v) => v.comments || []),
];
const wordLayer = (s) => layer(s, 'token:word');
const orthographyNames = (s) =>
  new Set((wordLayer(s)?.config?.igt?.orthographies || []).map((o) => o.name));
const ignoredConfig = (s) => wordLayer(s)?.config?.igt?.ignoredTokens ?? null;
const vocabFieldEntries = (s) =>
  vocabs(s).flatMap((v) => Object.entries(v.config?.igt?.fields || {}));
// Status is seeded on every new vocabulary (statusFieldSeed), so it counts as core here.
const CORE_ITEM_FIELDS = new Set([...CORE_VOCAB_FIELDS.map((f) => f.name), 'status']);
const IGT_ROLES = new Set(['baseline', 'sentence', 'word', 'morpheme', 'time-alignment']);
const PUNCT = /^[\p{P}\p{S}]+$/u;
const spanOnRole = (sp, role) =>
  sp.tokens.length > 0 && sp.tokens.every((k) => k.startsWith(`${role}:`));
const cps = (str) => [...(str ?? '')];
const hasProv = (md, key) => md && md[key] != null;
const provIs = (state) => (x) => provState(x.metadata) === state;
const baseline = (d) => d.texts.find((t) => t.layer === 'text:baseline')?.body ?? null;

// "word:4-9" -> "4-9", for matching a morpheme to its word by extent.
const extentOf = (key) => key.split(':')[1].split(/[@#]/)[0];
// Snapshot tokens are sorted by key, which is not text order ('word:10-15' < 'word:4-9').
const wordsInOrder = (d) =>
  tokensIn(d, 'word')
    .sort((a, b) => a.begin - b.begin)
    .map((t) => t.key);
const wordExtents = (d) => new Set(tokensIn(d, 'word').map((t) => `${t.begin}-${t.end}`));
const morphemesByWord = (d) => {
  const out = new Map();
  for (const m of tokensIn(d, 'morpheme')) {
    const k = `${m.begin}-${m.end}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
};
const sentenceOfExtent = (d, begin, end) =>
  tokensIn(d, 'sentence').find((s) => s.begin <= begin && end <= s.end);

// ---- the catalog ------------------------------------------------------------------

/** @type {{key: string, what: string, detect: (s: object) => number, foreign?: boolean, bare?: boolean}[]} */
export const FEATURES = [
  // Project configuration
  {
    key: 'project.documentMetadataFields',
    what: 'the document metadata fields the project has switched on',
    detect: (s) => (igt(s).documentMetadata || []).length,
    bare: true,
  },
  {
    key: 'project.documentMetadataTagset',
    what: 'a document metadata field governed by a tagset',
    detect: (s) => count(igt(s).documentMetadata, (f) => !!f?.tagset),
  },
  {
    key: 'project.tagset',
    what: 'a project tagset',
    detect: (s) => tagsets(s).length,
  },
  {
    key: 'project.tagsetModeSuggest',
    what: 'a tagset in suggest mode',
    detect: (s) => count(tagsets(s), (t) => t.mode === 'suggest'),
  },
  {
    key: 'project.tagsetModeClosed',
    what: 'a tagset in closed mode',
    detect: (s) => count(tagsets(s), (t) => t.mode === 'closed'),
  },
  {
    key: 'project.tagsetModeMixed',
    what: 'a tagset in mixed mode',
    detect: (s) => count(tagsets(s), (t) => t.mode === 'mixed'),
  },
  {
    key: 'project.tagsetDelimiters',
    what: 'a tagset whose values are split on delimiters',
    detect: (s) => count(tagsets(s), (t) => !!t.delimiters),
  },
  {
    key: 'project.tagsetValueDescription',
    what: 'a tagset value with a description',
    detect: (s) => tagsets(s).reduce((n, t) => n + count(t.values, (v) => !!v.description), 0),
  },
  {
    key: 'project.tagsetOrdered',
    what: 'a tagset whose values keep their written order',
    detect: (s) => count(tagsets(s), (t) => t.ordered === true),
  },
  {
    key: 'project.languageObject',
    what: 'the language being documented: name, Glottocode, ISO code, writing-system tag',
    detect: (s) => (nonEmptyObject(igt(s).languages?.object) ? 1 : 0),
  },
  {
    key: 'project.languageMeta',
    what: 'the language glosses and translations are written in',
    detect: (s) => (nonEmptyObject(igt(s).languages?.meta) ? 1 : 0),
  },
  {
    key: 'project.languageCoordinates',
    what: 'a language with a latitude and longitude',
    detect: (s) =>
      count(
        [igt(s).languages?.object, igt(s).languages?.meta],
        (l) => l?.latitude != null && l?.longitude != null,
      ),
  },
  {
    key: 'project.speakers',
    what: 'the known speaker labels',
    detect: (s) => (igt(s).speakers || []).length,
  },
  {
    key: 'project.serviceDefaults',
    what: 'stored service defaults',
    detect: (s) => (nonEmptyObject(igt(s).serviceDefaults) ? 1 : 0),
  },
  {
    key: 'project.autoAnalysis',
    what: 'stored auto-analysis settings',
    detect: (s) => (nonEmptyObject(igt(s).autoAnalysis) ? 1 : 0),
  },
  {
    key: 'project.compose',
    what: 'the project’s own compose codes',
    detect: (s) => (igt(s).compose?.codes || []).length,
  },
  {
    key: 'project.exportPresets',
    what: 'saved export presets',
    detect: (s) => (igt(s).export?.presets || []).length,
  },
  {
    key: 'project.reviewedMembers',
    what: 'whose work is reviewed (names users)',
    detect: (s) => (nonEmptyObject(s.config?.plaid?.review) ? 1 : 0),
  },
  {
    key: 'project.foreignConfig',
    what: 'project config another app keeps under its own namespace',
    detect: (s) => count(Object.keys(s.config || {}), (ns) => ns !== 'igt' && ns !== 'plaid'),
    foreign: true,
  },

  // Layers
  {
    key: 'layers.orthography',
    what: 'a non-baseline orthography on the word layer',
    detect: (s) => orthographyNames(s).size,
  },
  {
    key: 'layers.ignoredTokensPunctuation',
    what: 'words that are all punctuation are skipped',
    detect: (s) => (ignoredConfig(s)?.type === 'unicodePunctuation' ? 1 : 0),
    bare: true,
  },
  {
    key: 'layers.ignoredTokensLetterLike',
    what: 'punctuation characters the project treats as letters',
    detect: (s) => (ignoredConfig(s)?.whitelist || []).length,
  },
  {
    key: 'layers.ignoredTokensBlacklist',
    what: 'an explicit list of tokens to skip, instead of the punctuation rule',
    detect: (s) => (ignoredConfig(s)?.type === 'blacklist' ? 1 : 0),
  },
  {
    key: 'layers.fieldSentence',
    what: 'an annotation field at sentence scope',
    detect: (s) => count(spanLayers(s), (l) => l.config?.igt?.scope === 'Sentence'),
    bare: true,
  },
  {
    key: 'layers.fieldWord',
    what: 'an annotation field at word scope',
    detect: (s) => count(spanLayers(s), (l) => l.config?.igt?.scope === 'Word'),
    bare: true,
  },
  {
    key: 'layers.fieldMorpheme',
    what: 'an annotation field at morpheme scope',
    detect: (s) => count(spanLayers(s), (l) => l.config?.igt?.scope === 'Morpheme'),
    bare: true,
  },
  {
    key: 'layers.fieldSameNameTwoScopes',
    what: 'two fields with one name at different scopes (Gloss on words and on morphemes)',
    detect: (s) => {
      const byName = new Map();
      for (const l of spanLayers(s)) {
        if (!l.config?.igt?.scope) continue;
        byName.set(l.name, (byName.get(l.name) ?? 0) + 1);
      }
      return count([...byName.values()], (n) => n > 1);
    },
    bare: true,
  },
  {
    key: 'layers.fieldOrder',
    what: 'annotation fields at one scope in an order other than alphabetical',
    detect: (s) => {
      const byParent = new Map();
      for (const l of spanLayers(s)) {
        const parent = l.key.slice(0, l.key.indexOf('/'));
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(l);
      }
      return count([...byParent.values()], (ls) => {
        const names = ls.sort((a, b) => a.position - b.position).map((l) => l.name);
        return names.join('\n') !== [...names].sort().join('\n');
      });
    },
  },
  {
    key: 'layers.fieldLang',
    what: 'an annotation field that records its writing system',
    detect: (s) => count(spanLayers(s), (l) => !!l.config?.igt?.lang),
  },
  {
    key: 'layers.fieldTagset',
    what: 'an annotation field governed by a tagset',
    detect: (s) => count(spanLayers(s), (l) => !!l.config?.igt?.tagset),
  },
  {
    key: 'layers.foreignTokenLayer',
    what: 'a token layer with a role plaid-igt does not use (plaid-ud’s syntactic words)',
    detect: (s) =>
      count(
        (s.layers || []).filter((l) => l.key.startsWith('token:')),
        (l) => !IGT_ROLES.has(l.config?.plaid?.role),
      ),
    foreign: true,
  },
  {
    key: 'layers.unscopedSpanLayer',
    what: 'a span layer with no IGT scope, made by another app',
    detect: (s) => count(spanLayers(s), (l) => !l.config?.igt?.scope),
    foreign: true,
  },
  {
    key: 'layers.relationLayer',
    what: 'a relation layer (plaid-ud’s dependencies)',
    detect: (s) => count(s.layers, (l) => l.key.startsWith('relation:')),
    foreign: true,
  },

  // Vocabularies: their schema
  {
    key: 'vocab.linked',
    what: 'a vocabulary linked to the project',
    detect: (s) => vocabs(s).length,
    bare: true,
  },
  {
    key: 'vocab.second',
    what: 'a second vocabulary linked to the same project',
    detect: (s) => Math.max(0, vocabs(s).length - 1),
  },
  {
    key: 'vocab.customField',
    what: 'a vocabulary field beyond the core ones',
    detect: (s) =>
      count(
        vocabFieldEntries(s),
        ([name]) => !CORE_ITEM_FIELDS.has(name.replace(/\s\([^()]+\)$/, '')),
      ),
  },
  {
    key: 'vocab.fieldNotInline',
    what: 'a vocabulary field shown only in the entry detail',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => f?.inline === false),
    bare: true,
  },
  {
    key: 'vocab.fieldTagset',
    what: 'a vocabulary field governed by one of the vocabulary’s tagsets',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => !!f?.tagset),
    bare: true,
  },
  {
    key: 'vocab.fieldLang',
    what: 'a vocabulary field that records its writing system',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => !!f?.lang),
  },
  {
    key: 'vocab.fieldMultilingual',
    what: 'a field in a second writing system, named with its suffix (“gloss (ru)”)',
    detect: (s) => count(vocabFieldEntries(s), ([name]) => /\s\([^()]+\)$/.test(name)),
  },
  {
    key: 'vocab.fieldItemRef',
    what: 'a field that refers to one other entry',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => f?.type === 'item' && !f?.many),
  },
  {
    key: 'vocab.fieldItemRefMany',
    what: 'a field that refers to a list of other entries',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => f?.type === 'item' && f?.many),
  },
  {
    key: 'vocab.fieldEntryScope',
    what: 'a field shown on the headword only',
    detect: (s) => count(vocabFieldEntries(s), ([, f]) => f?.scope === 'entry'),
  },
  {
    key: 'vocab.customTagset',
    what: 'a vocabulary tagset beyond the seeded Status list',
    detect: (s) =>
      vocabs(s).reduce(
        (n, v) => n + count(Object.keys(v.config?.igt?.tagsets || {}), (k) => k !== 'Status'),
        0,
      ),
  },
  {
    key: 'vocab.foreignConfig',
    what: 'vocabulary config another app keeps (plaid-dict’s publication record)',
    detect: (s) =>
      vocabs(s).reduce((n, v) => n + count(Object.keys(v.config || {}), (ns) => ns !== 'igt'), 0),
  },

  // Vocabularies: entries
  ...['gloss', 'pos', 'morphType', 'definition', 'status', 'lexemeForm'].map((f) => ({
    key: `item.${f}`,
    what: `an entry’s ${f}`,
    detect: (s) => count(items(s), (it) => it.metadata?.[f] != null && it.metadata[f] !== ''),
  })),
  {
    key: 'item.customFieldValue',
    what: 'a value in a custom text field',
    detect: (s) => {
      const custom = new Set(
        vocabFieldEntries(s)
          .filter(
            ([name, f]) =>
              f?.type !== 'item' && !CORE_ITEM_FIELDS.has(name) && name !== 'lexemeForm',
          )
          .filter(([name]) => !/\s\([^()]+\)$/.test(name))
          .map(([name]) => name),
      );
      return count(items(s), (it) => Object.keys(it.metadata || {}).some((k) => custom.has(k)));
    },
  },
  {
    key: 'item.multilingualValue',
    what: 'a value in a second writing system (“gloss (ru)”)',
    detect: (s) =>
      count(items(s), (it) => Object.keys(it.metadata || {}).some((k) => /\s\([^()]+\)$/.test(k))),
  },
  {
    key: 'item.itemRefValue',
    what: 'an entry referring to another entry',
    detect: (s) => {
      const single = new Set(
        vocabFieldEntries(s)
          .filter(([, f]) => f?.type === 'item' && !f?.many)
          .map(([n]) => n),
      );
      return count(items(s), (it) => [...single].some((k) => it.metadata?.[k] != null));
    },
  },
  {
    key: 'item.itemRefManyValue',
    what: 'an entry referring to a list of other entries',
    detect: (s) => {
      const many = new Set(
        vocabFieldEntries(s)
          .filter(([, f]) => f?.type === 'item' && f?.many)
          .map(([n]) => n),
      );
      return count(items(s), (it) => [...many].some((k) => (it.metadata?.[k] || []).length > 0));
    },
  },
  {
    key: 'item.sense',
    what: 'a sense (an entry under another entry)',
    detect: (s) => count(items(s), (it) => it.metadata?.parent != null),
  },
  {
    key: 'item.subsense',
    what: 'a sense of a sense',
    detect: (s) => {
      const byKey = new Map(items(s).map((it) => [it.key, it]));
      return count(items(s), (it) => byKey.get(it.metadata?.parent)?.metadata?.parent != null);
    },
  },
  {
    key: 'item.senseOrder',
    what: 'senses in an order set by hand',
    detect: (s) => count(items(s), (it) => it.metadata?.senseOrder != null),
  },
  {
    key: 'item.homonyms',
    what: 'two headwords spelled the same',
    // Not the item key's `#2`: a sense takes its headword's form, so every
    // sense would count.
    detect: (s) =>
      vocabs(s).reduce((n, v) => {
        const forms = v.items.filter((it) => it.metadata?.parent == null).map((it) => it.form);
        return n + forms.length - new Set(forms).size;
      }, 0),
  },
  {
    key: 'item.homographNumber',
    what: 'an entry number set on a headword',
    detect: (s) => count(items(s), (it) => it.metadata?.homograph != null),
  },
  {
    key: 'item.exampleCorpus',
    what: 'a sentence from the corpus promoted to an entry’s example',
    detect: (s) =>
      items(s).reduce(
        (n, it) =>
          n + count(it.metadata?.examples, (ex) => ex && typeof ex === 'object' && 'token' in ex),
        0,
      ),
  },
  {
    key: 'item.exampleText',
    what: 'an example stored as text and translation (from a FLEx import)',
    detect: (s) =>
      items(s).reduce(
        (n, it) =>
          n + count(it.metadata?.examples, (ex) => ex && typeof ex === 'object' && 'text' in ex),
        0,
      ),
  },
  {
    key: 'item.flexIdentity',
    what: 'FLEx’s own entry and sense guids',
    detect: (s) =>
      count(items(s), (it) => it.metadata?.flexEntry != null || it.metadata?.flexSense != null),
  },
  {
    key: 'item.provenance',
    what: 'provenance on an entry',
    detect: (s) => count(items(s), (it) => hasProv(it.metadata, 'prov')),
  },
  {
    key: 'item.zeroMorph',
    what: 'an entry whose form is the zero morph',
    detect: (s) => count(items(s), (it) => it.form === '∅'),
  },
  {
    key: 'item.unlinked',
    what: 'an entry no token links to',
    detect: (s) => {
      const linked = new Set(allLinks(s).map((l) => `${l.vocab}|${l.item}`));
      return vocabs(s).reduce(
        (n, v) => n + count(v.items, (it) => !linked.has(`${v.name}|${it.key}`)),
        0,
      );
    },
  },
  {
    key: 'item.extraMetadata',
    what: 'an entry metadata key no field declares',
    detect: (s) =>
      vocabs(s).reduce((n, v) => {
        const declared = new Set(Object.keys(v.config?.igt?.fields || {}));
        return (
          n +
          count(v.items, (it) =>
            Object.keys(it.metadata || {}).some(
              (k) => !declared.has(k) && !RESERVED_ITEM_KEYS.has(k) && !k.startsWith('prov'),
            ),
          )
        );
      }, 0),
  },

  // Documents
  {
    key: 'document.metadataConfigured',
    what: 'a value in a switched-on document metadata field',
    detect: (s) => {
      const on = new Set((igt(s).documentMetadata || []).map((f) => f.name));
      return sum(s, (d) => count(Object.keys(d.metadata), (k) => on.has(k)));
    },
  },
  {
    key: 'document.metadataUnconfigured',
    what: 'a document metadata value under a name no field is switched on for',
    detect: (s) => {
      const on = new Set((igt(s).documentMetadata || []).map((f) => f.name));
      return sum(s, (d) =>
        count(
          Object.keys(d.metadata),
          (k) => !on.has(k) && k !== 'plaid' && k !== 'speechDetection',
        ),
      );
    },
  },
  {
    key: 'document.textDirection',
    what: 'a document set to read right to left',
    detect: (s) => sum(s, (d) => (d.metadata?.plaid?.textDirection ? 1 : 0)),
  },
  {
    key: 'document.speechDetection',
    what: 'kept speech-detection cuts',
    detect: (s) => sum(s, (d) => (d.metadata?.speechDetection != null ? 1 : 0)),
  },
  {
    key: 'document.media',
    what: 'a recording',
    detect: (s) => sum(s, (d) => (d.media ? 1 : 0)),
  },
  {
    key: 'document.noText',
    what: 'a document with no baseline text yet',
    detect: (s) => sum(s, (d) => (baseline(d) == null ? 1 : 0)),
  },
  {
    key: 'document.untokenized',
    what: 'a document with sentences but no words',
    detect: (s) =>
      sum(s, (d) =>
        tokensIn(d, 'sentence').length > 0 && tokensIn(d, 'word').length === 0 ? 1 : 0,
      ),
  },
  {
    key: 'document.duplicateName',
    what: 'two documents with the same name',
    detect: (s) => count(docs(s), (d) => /#\d+$/.test(d.name)),
  },
  {
    key: 'document.nameSpecialChars',
    what: 'a document name with characters a file name cannot hold as they are (/ : " ?)',
    detect: (s) => count(docs(s), (d) => /[/\\:"?*<>|]/.test(d.name)),
  },

  // What the text is made of
  {
    key: 'text.astral',
    what: 'a character outside the Basic Multilingual Plane',
    detect: (s) => sum(s, (d) => (cps(baseline(d)).some((c) => c.codePointAt(0) > 0xffff) ? 1 : 0)),
  },
  {
    key: 'text.combining',
    what: 'a combining mark',
    detect: (s) => sum(s, (d) => (/\p{M}/u.test(baseline(d) ?? '') ? 1 : 0)),
  },
  {
    key: 'text.rtlScript',
    what: 'text in a right-to-left script',
    detect: (s) =>
      sum(s, (d) =>
        /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(
          baseline(d) ?? '',
        )
          ? 1
          : 0,
      ),
  },
  {
    key: 'text.multiline',
    what: 'a baseline over several lines',
    detect: (s) => sum(s, (d) => ((baseline(d) ?? '').includes('\n') ? 1 : 0)),
  },
  {
    key: 'text.blankLine',
    what: 'a blank line (an empty paragraph)',
    detect: (s) => sum(s, (d) => (/\n[ \t]*\n/.test(baseline(d) ?? '') ? 1 : 0)),
  },
  {
    key: 'text.markupChars',
    what: 'characters XML and CSV treat specially (< & " , and a tab)',
    detect: (s) => sum(s, (d) => (/[<&",\t]/.test(baseline(d) ?? '') ? 1 : 0)),
  },
  {
    key: 'text.zeroMorph',
    what: 'the zero morph written in the baseline',
    detect: (s) => sum(s, (d) => ((baseline(d) ?? '').includes('∅') ? 1 : 0)),
  },

  // Tokens
  {
    key: 'token.sentence',
    what: 'a sentence',
    detect: (s) => sum(s, (d) => tokensIn(d, 'sentence').length),
  },
  {
    key: 'token.word',
    what: 'a word',
    detect: (s) => sum(s, (d) => tokensIn(d, 'word').length),
  },
  {
    key: 'token.ignoredWord',
    what: 'a word token that is all punctuation',
    detect: (s) =>
      sum(s, (d) => {
        const body = cps(baseline(d));
        return count(tokensIn(d, 'word'), (t) => PUNCT.test(body.slice(t.begin, t.end).join('')));
      }),
  },
  {
    key: 'token.untokenizedText',
    what: 'text inside a sentence that no word covers, other than spaces',
    detect: (s) =>
      sum(s, (d) => {
        const body = cps(baseline(d));
        const covered = new Array(body.length).fill(false);
        for (const t of tokensIn(d, 'word'))
          for (let i = t.begin; i < t.end; i++) covered[i] = true;
        if (!tokensIn(d, 'word').length) return 0;
        return count(body, (c, i) => !covered[i] && !/\s/u.test(c)) > 0 ? 1 : 0;
      }),
  },
  {
    key: 'token.orthographyValue',
    what: 'a word’s spelling in another orthography',
    detect: (s) => {
      const names = orthographyNames(s);
      return sum(s, (d) =>
        count(tokensIn(d, 'word'), (t) =>
          [...names].some((n) => t.metadata[`orthog:${n}`] != null),
        ),
      );
    },
  },
  {
    key: 'token.orthographyUnconfigured',
    what: 'an orthography value under a name no orthography is configured for',
    detect: (s) => {
      const names = orthographyNames(s);
      return sum(s, (d) =>
        count(tokensIn(d, 'word'), (t) =>
          Object.keys(t.metadata).some((k) => k.startsWith('orthog:') && !names.has(k.slice(7))),
        ),
      );
    },
  },
  {
    key: 'token.wordExtraMetadata',
    what: 'a word carrying metadata the app does not define',
    detect: (s) =>
      sum(s, (d) =>
        count(tokensIn(d, 'word'), (t) =>
          Object.keys(t.metadata).some((k) => !k.startsWith('orthog:') && !k.startsWith('prov')),
        ),
      ),
  },
  {
    key: 'token.segmentedWord',
    what: 'a word split into two or more morphemes',
    detect: (s) => sum(s, (d) => count([...morphemesByWord(d).values()], (n) => n >= 2)),
  },
  {
    key: 'token.singleStoredMorpheme',
    what: 'a word with exactly one stored morpheme',
    detect: (s) => sum(s, (d) => count([...morphemesByWord(d).values()], (n) => n === 1)),
  },
  {
    key: 'token.unanalyzedWord',
    what: 'a word nobody has analyzed (no morpheme stored, the app shows a derived one)',
    detect: (s) =>
      sum(s, (d) => {
        const withMorphemes = morphemesByWord(d);
        const body = cps(baseline(d));
        return count(
          tokensIn(d, 'word'),
          (t) =>
            !withMorphemes.has(`${t.begin}-${t.end}`) &&
            !PUNCT.test(body.slice(t.begin, t.end).join('')),
        );
      }),
  },
  {
    key: 'token.morphemeForm',
    what: 'a morpheme with its own form',
    detect: (s) =>
      sum(s, (d) =>
        count(
          tokensIn(d, 'morpheme'),
          (m) => typeof m.metadata.form === 'string' && m.metadata.form !== '',
        ),
      ),
  },
  {
    key: 'token.morphemeFormEmpty',
    what: 'a morpheme whose form was deliberately set empty',
    detect: (s) => sum(s, (d) => count(tokensIn(d, 'morpheme'), (m) => m.metadata.form === '')),
  },
  {
    key: 'token.morphemeFormAbsent',
    what: 'a stored morpheme with no form of its own (it shows the word’s text)',
    detect: (s) => sum(s, (d) => count(tokensIn(d, 'morpheme'), (m) => !('form' in m.metadata))),
  },
  {
    key: 'token.morphemeZero',
    what: 'a zero morpheme',
    detect: (s) => sum(s, (d) => count(tokensIn(d, 'morpheme'), (m) => m.metadata.form === '∅')),
  },
  {
    key: 'token.morphTypeOnMorpheme',
    what: 'a morph type recorded on a morpheme',
    detect: (s) => sum(s, (d) => count(tokensIn(d, 'morpheme'), (m) => !!m.metadata.morphType)),
  },
  {
    key: 'token.orphanMorpheme',
    what: 'a morpheme whose extent matches no word',
    detect: (s) =>
      sum(s, (d) => {
        const words = wordExtents(d);
        return count(tokensIn(d, 'morpheme'), (m) => !words.has(`${m.begin}-${m.end}`));
      }),
  },
  {
    key: 'token.provenance',
    what: 'provenance on a sentence or word (a tokenizer made it)',
    detect: (s) =>
      sum(s, (d) =>
        count([...tokensIn(d, 'sentence'), ...tokensIn(d, 'word')], (t) =>
          hasProv(t.metadata, 'prov'),
        ),
      ),
  },
  {
    key: 'alignment.times',
    what: 'a time-aligned segment',
    detect: (s) =>
      sum(s, (d) => count(tokensIn(d, 'time-alignment'), (t) => t.metadata.timeBegin != null)),
  },
  {
    key: 'alignment.speaker',
    what: 'a segment with a speaker',
    detect: (s) => sum(s, (d) => count(tokensIn(d, 'time-alignment'), (t) => !!t.metadata.speaker)),
  },
  {
    key: 'alignment.extraMetadata',
    what: 'segment metadata beyond its times and speaker',
    detect: (s) =>
      sum(s, (d) =>
        count(tokensIn(d, 'time-alignment'), (t) =>
          Object.keys(t.metadata).some((k) => !['timeBegin', 'timeEnd', 'speaker'].includes(k)),
        ),
      ),
  },
  {
    key: 'alignment.notSentenceExtent',
    what: 'a segment that does not coincide with a sentence',
    detect: (s) =>
      sum(s, (d) => {
        const sentences = new Set(tokensIn(d, 'sentence').map((t) => `${t.begin}-${t.end}`));
        return count(tokensIn(d, 'time-alignment'), (t) => !sentences.has(`${t.begin}-${t.end}`));
      }),
  },
  {
    key: 'alignment.overlappingTimes',
    what: 'two segments whose times overlap (overlapping speech)',
    detect: (s) =>
      sum(s, (d) => {
        const segs = tokensIn(d, 'time-alignment')
          .filter((t) => t.metadata.timeBegin != null)
          .sort((a, b) => a.metadata.timeBegin - b.metadata.timeBegin);
        return count(segs.slice(1), (t, i) => t.metadata.timeBegin < segs[i].metadata.timeEnd);
      }),
  },

  // Annotations (spans)
  ...['Sentence', 'Word', 'Morpheme'].map((scope) => ({
    key: `span.${scope.toLowerCase()}Value`,
    what: `an annotation value at ${scope.toLowerCase()} scope`,
    detect: (s) => count(allSpans(s), (sp) => scopeOf(s, sp.layer) === scope),
  })),
  {
    key: 'span.multiToken',
    what: 'one annotation over several tokens',
    detect: (s) => count(allSpans(s), (sp) => sp.tokens.length > 1),
  },
  {
    key: 'span.duplicate',
    what: 'two annotations in one field on the same token',
    detect: (s) =>
      sum(s, (d) => {
        const seen = new Map();
        for (const sp of d.spans) {
          const k = `${sp.layer}|${sp.tokens.join(',')}`;
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
        return count([...seen.values()], (n) => n > 1);
      }),
  },
  {
    key: 'span.onForeignLayer',
    what: 'an annotation in a span layer with no IGT scope',
    detect: (s) => count(allSpans(s), (sp) => !scopeOf(s, sp.layer)),
    foreign: true,
  },
  {
    key: 'span.onAlignment',
    what: 'an annotation on a time-aligned segment',
    detect: (s) => count(allSpans(s), (sp) => spanOnRole(sp, 'time-alignment')),
  },
  ...['human', 'machine', 'contributed', 'verified'].map((state) => ({
    key: `span.prov${state[0].toUpperCase()}${state.slice(1)}`,
    what: `an annotation whose provenance is ${state}`,
    detect: (s) => count(allSpans(s), provIs(state)),
  })),
  ...['provSource', 'provProb', 'provDetail'].map((k) => ({
    key: `span.${k}`,
    what: `an annotation carrying ${k}`,
    detect: (s) => count(allSpans(s), (sp) => hasProv(sp.metadata, k)),
  })),
  {
    key: 'span.extraMetadata',
    what: 'annotation metadata beyond provenance',
    detect: (s) =>
      count(allSpans(s), (sp) => Object.keys(sp.metadata).some((k) => !k.startsWith('prov'))),
  },
  {
    key: 'span.offTagset',
    what: 'a value outside the tagset that governs its field',
    detect: (s) =>
      count(allSpans(s), (sp) => {
        const name = layer(s, sp.layer)?.config?.igt?.tagset;
        const ts = name ? igt(s).tagsets?.[name] : null;
        if (!ts || ts.delimiters) return false;
        return !(ts.values || []).some((v) => v.value === sp.value);
      }),
  },
  {
    key: 'span.delimitedValue',
    what: 'a value made of several tags (“1SG-PST”)',
    detect: (s) =>
      count(allSpans(s), (sp) => {
        const name = layer(s, sp.layer)?.config?.igt?.tagset;
        const delims = name ? igt(s).tagsets?.[name]?.delimiters : '';
        return !!delims && [...delims].some((c) => (sp.value ?? '').includes(c));
      }),
  },
  {
    key: 'span.markupChars',
    what: 'an annotation value with characters XML and CSV treat specially (< & " , and a tab)',
    detect: (s) => count(allSpans(s), (sp) => /[<&",\t]/.test(sp.value ?? '')),
  },
  {
    key: 'span.multilineValue',
    what: 'an annotation value over several lines',
    detect: (s) => count(allSpans(s), (sp) => (sp.value ?? '').includes('\n')),
  },
  {
    key: 'span.emptyValue',
    what: 'an annotation whose value is the empty string',
    detect: (s) => count(allSpans(s), (sp) => sp.value === ''),
  },

  // Vocabulary links
  {
    key: 'link.word',
    what: 'a word linked to an entry',
    detect: (s) =>
      count(allLinks(s), (l) => l.tokens.length === 1 && l.tokens[0].startsWith('word:')),
  },
  {
    key: 'link.morpheme',
    what: 'a morpheme linked to an entry',
    detect: (s) =>
      count(allLinks(s), (l) => l.tokens.length === 1 && l.tokens[0].startsWith('morpheme:')),
  },
  {
    key: 'link.mwe',
    what: 'a multi-word expression over adjacent words',
    detect: (s) =>
      sum(s, (d) => {
        const words = wordsInOrder(d);
        return count(d.links, (l) => {
          if (l.tokens.length < 2 || !l.tokens.every((k) => k.startsWith('word:'))) return false;
          const idx = l.tokens.map((k) => words.indexOf(k)).sort((a, b) => a - b);
          return idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
        });
      }),
  },
  {
    key: 'link.mweDiscontinuous',
    what: 'a multi-word expression with a word between its members',
    detect: (s) =>
      sum(s, (d) => {
        const words = wordsInOrder(d);
        return count(d.links, (l) => {
          if (l.tokens.length < 2 || !l.tokens.every((k) => k.startsWith('word:'))) return false;
          const idx = l.tokens.map((k) => words.indexOf(k)).sort((a, b) => a - b);
          return idx.some((v, i) => i > 0 && v !== idx[i - 1] + 1);
        });
      }),
  },
  {
    key: 'link.mweAcrossSentences',
    what: 'a multi-word expression whose words are in different sentences',
    detect: (s) =>
      sum(s, (d) =>
        count(d.links, (l) => {
          if (l.tokens.length < 2 || !l.tokens.every((k) => k.startsWith('word:'))) return false;
          const homes = new Set(
            l.tokens.map((k) => {
              const [b, e] = extentOf(k).split('-').map(Number);
              return sentenceOfExtent(d, b, e)?.key;
            }),
          );
          return homes.size > 1;
        }),
      ),
  },
  {
    key: 'link.onSentence',
    what: 'an entry linked to a whole sentence',
    detect: (s) => count(allLinks(s), (l) => l.tokens.some((k) => k.startsWith('sentence:'))),
  },
  {
    key: 'link.duplicateOnToken',
    what: 'two links on the same single token',
    detect: (s) =>
      sum(s, (d) => {
        const seen = new Map();
        for (const l of d.links) {
          if (l.tokens.length !== 1) continue;
          seen.set(l.tokens[0], (seen.get(l.tokens[0]) ?? 0) + 1);
        }
        return count([...seen.values()], (n) => n > 1);
      }),
  },
  {
    key: 'link.toSense',
    what: 'a token linked to a sense rather than a headword',
    detect: (s) => {
      const senses = new Set(
        vocabs(s).flatMap((v) =>
          v.items.filter((it) => it.metadata?.parent != null).map((it) => `${v.name}|${it.key}`),
        ),
      );
      return count(allLinks(s), (l) => senses.has(`${l.vocab}|${l.item}`));
    },
  },
  {
    key: 'link.secondVocabulary',
    what: 'links into two vocabularies in one project',
    detect: (s) => Math.max(0, new Set(allLinks(s).map((l) => l.vocab)).size - 1),
  },
  ...['human', 'machine', 'contributed', 'verified'].map((state) => ({
    key: `link.prov${state[0].toUpperCase()}${state.slice(1)}`,
    what: `a link whose provenance is ${state}`,
    detect: (s) => count(allLinks(s), provIs(state)),
  })),
  ...['provSource', 'provProb', 'provDetail'].map((k) => ({
    key: `link.${k}`,
    what: `a link carrying ${k}`,
    detect: (s) => count(allLinks(s), (l) => hasProv(l.metadata, k)),
  })),

  // Relations (plaid-ud)
  {
    key: 'relation.value',
    what: 'a relation between two annotations',
    detect: (s) => sum(s, (d) => d.relations.length),
    foreign: true,
  },

  // Comments
  ...[
    ['document', (c) => c.anchor.type === 'document'],
    ['text', (c) => c.anchor.type === 'text'],
    ['sentence', (c) => c.anchor.type === 'token' && c.anchor.ref?.startsWith('sentence:')],
    ['word', (c) => c.anchor.type === 'token' && c.anchor.ref?.startsWith('word:')],
    ['morpheme', (c) => c.anchor.type === 'token' && c.anchor.ref?.startsWith('morpheme:')],
    ['segment', (c) => c.anchor.type === 'token' && c.anchor.ref?.startsWith('time-alignment:')],
    ['annotation', (c) => c.anchor.type === 'span'],
    ['entry', (c) => c.anchor.type === 'vocab-item'],
  ].map(([what, pred]) => ({
    key: `comment.${what}`,
    what: `a comment on a ${what}`,
    detect: (s) => count(allComments(s), (c) => c.anchor.ref != null && pred(c)),
  })),
  {
    key: 'comment.relation',
    what: 'a comment on a relation',
    detect: (s) =>
      count(allComments(s), (c) => c.anchor.type === 'relation' && c.anchor.ref != null),
    foreign: true,
  },
  {
    key: 'comment.orphaned',
    what: 'a comment whose anchor has been deleted',
    detect: (s) => count(allComments(s), (c) => c.anchor.ref == null),
  },
  {
    key: 'comment.edited',
    what: 'a comment edited after it was posted',
    detect: (s) => count(allComments(s), (c) => c.edited),
  },
  {
    key: 'comment.anchorLabel',
    what: 'a comment posted with a caption saying what it is about',
    detect: (s) => count(allComments(s), (c) => !!c.anchorLabel),
  },
  {
    key: 'comment.secondAuthor',
    what: 'comments by two different people',
    detect: (s) => Math.max(0, new Set(allComments(s).map((c) => c.author)).size - 1),
  },
  {
    key: 'comment.markdown',
    what: 'a comment body over several lines of Markdown',
    detect: (s) => count(allComments(s), (c) => c.body.includes('\n')),
  },

  // Guidelines
  {
    key: 'guideline.present',
    what: 'a guideline',
    detect: (s) => (s.guidelines || []).length,
  },
  {
    key: 'guideline.pinned',
    what: 'a pinned guideline',
    detect: (s) => count(s.guidelines, (g) => g.pinned),
  },
  {
    key: 'guideline.emptyBody',
    what: 'a guideline with a title and no body yet',
    detect: (s) => count(s.guidelines, (g) => g.body === ''),
  },
  {
    key: 'guideline.duplicateTitle',
    what: 'two guidelines with the same title',
    detect: (s) => {
      const titles = (s.guidelines || []).map((g) => g.title);
      return titles.length - new Set(titles).size;
    },
  },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

/** Count every feature over a set of project snapshots: key -> count. */
export function detectFeatures(snapshots) {
  const out = new Map(FEATURES.map((f) => [f.key, 0]));
  for (const snap of snapshots) {
    for (const f of FEATURES) out.set(f.key, out.get(f.key) + f.detect(snap));
  }
  return out;
}
