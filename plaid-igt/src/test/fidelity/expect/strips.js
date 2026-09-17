// What "lost" means for each catalog feature, as an edit to a snapshot.
//
// When a format's list says a feature is not carried, the expected snapshot is
// the source with that feature taken out, and for an undecided feature it is
// taken out of both sides so neither answer fails. `STRIPS[key](snapshot)`
// takes it out, in place.
//
// Each strip removes the feature and nothing else: a provenance strip deletes
// the marks and leaves the annotation, a tagset-mode strip removes the tagsets
// in that mode and leaves the others. That precision is the point. A strip
// that removed more would hide a difference in something the format does
// carry. Where a format loses a feature in a way these do not describe (CLDF
// turns an unanalyzed word into one stored morpheme rather than dropping
// anything), that format's own module in this directory overrides the entry.
//
// A few features cannot be removed on their own because they are a property of
// something another key removes (a document is only partly aligned while it has
// segments). Those are `coveredBy` the key that does the removing, and the
// guard test checks that the covering key is lost too wherever they are.

import { fieldNameLang } from '../../../domain/fieldNames.js';
import { isTokenIgnored } from '../../../domain/igtConfig.js';
import { CORE_VOCAB_FIELDS, RESERVED_ITEM_KEYS } from '../../../domain/vocabFields.js';
import { provState } from '@larc-iu/plaid-client';
import {
  baselineOf,
  byBegin,
  docs,
  isProvKey,
  layer,
  omitKeys,
  removeComments,
  removeDocuments,
  removeLayers,
  removeRelations,
  removeSpans,
  removeTokens,
  tokensIn,
} from './snap.js';

/** An entry that says a key's loss is another key's removal. */
export const coveredBy = (key, why) => ({ coveredBy: key, why });

const IGT_ROLES = new Set(['baseline', 'sentence', 'word', 'morpheme', 'time-alignment']);
const CORE_ITEM_FIELDS = new Set([...CORE_VOCAB_FIELDS.map((f) => f.name), 'status', 'lexemeForm']);
const ITEM_STAMPS = new Set(['cldfEntry', 'nativeImportId']);
const DOCUMENT_STAMPS = new Set(['importSource', 'importDone']);

const vocabs = (s) => s.vocabularies || [];
const items = (s) => vocabs(s).flatMap((v) => v.items);
const allSpans = (s) => docs(s).flatMap((d) => d.spans.map((sp) => [d, sp]));
const tagsets = (s) => s.config?.igt?.tagsets || {};
const wordLayer = (s) => layer(s, 'token:word');
const PROV_KEYS = ['prov', 'provSource', 'provConfirmed', 'provProb', 'provDetail'];

/** Server order among spans (snapshot.mjs `order`), the order "first" means. */
export const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity);

const pruneEmpty = (obj, key) => {
  const v = obj?.[key];
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
    delete obj[key];
  }
};

const dropIgt = (key) => (s) => {
  if (s.config?.igt) delete s.config.igt[key];
};

const removeTagsets = (pred) => (s) => {
  const ts = tagsets(s);
  for (const [name, t] of Object.entries(ts)) if (pred(t)) delete ts[name];
};

const removeProvFrom = (metadata) => omitKeys(metadata, (k) => PROV_KEYS.includes(k));

const removeExamples = (pred) => (s) => {
  for (const it of items(s)) {
    const ex = it.metadata?.examples;
    if (!Array.isArray(ex)) continue;
    it.metadata.examples = ex.filter((e) => !pred(e));
    if (!it.metadata.examples.length) delete it.metadata.examples;
  }
};

// Which spans a comment anchor names, for the comment strips.
const tokenRole = (ref, role) => typeof ref === 'string' && ref.startsWith(`${role}:`);
const removeCommentsOn = (pred) => (s) => removeComments(s, (c) => c.anchor.ref != null && pred(c));

const sortedLinks = (d) => {
  const words = tokensIn(d, 'word')
    .sort(byBegin)
    .map((t) => t.key);
  return (l) => l.tokens.map((k) => words.indexOf(k)).sort((a, b) => a - b);
};
const isMwe = (l) => l.tokens.length >= 2 && l.tokens.every((k) => k.startsWith('word:'));

export const STRIPS = {
  // ---- project configuration ----
  'project.documentMetadataFields': dropIgt('documentMetadata'),
  'project.documentMetadataTagset': (s) => {
    for (const f of s.config?.igt?.documentMetadata || []) delete f.tagset;
  },
  'project.tagset': dropIgt('tagsets'),
  'project.tagsetModeSuggest': removeTagsets((t) => t.mode === 'suggest'),
  'project.tagsetModeClosed': removeTagsets((t) => t.mode === 'closed'),
  'project.tagsetModeMixed': removeTagsets((t) => t.mode === 'mixed'),
  'project.tagsetDelimiters': removeTagsets((t) => !!t.delimiters),
  'project.tagsetValueDescription': (s) => {
    for (const t of Object.values(tagsets(s))) for (const v of t.values || []) delete v.description;
  },
  'project.tagsetOrdered': (s) => {
    for (const t of Object.values(tagsets(s))) delete t.ordered;
  },
  'project.languageObject': (s) => {
    if (s.config?.igt?.languages) delete s.config.igt.languages.object;
    pruneEmpty(s.config?.igt, 'languages');
  },
  'project.languageMeta': (s) => {
    if (s.config?.igt?.languages) delete s.config.igt.languages.meta;
    pruneEmpty(s.config?.igt, 'languages');
  },
  'project.languageCoordinates': (s) => {
    for (const l of Object.values(s.config?.igt?.languages || {})) {
      if (l && typeof l === 'object') {
        delete l.latitude;
        delete l.longitude;
      }
    }
  },
  'project.speakers': dropIgt('speakers'),
  'project.serviceDefaults': dropIgt('serviceDefaults'),
  'project.autoAnalysis': dropIgt('autoAnalysis'),
  'project.compose': dropIgt('compose'),
  'project.exportPresets': dropIgt('export'),
  'project.reviewedMembers': (s) => {
    if (s.config?.plaid) delete s.config.plaid.review;
    pruneEmpty(s.config, 'plaid');
  },
  'project.foreignConfig': (s) => {
    omitKeys(s.config, (ns) => ns !== 'igt' && ns !== 'plaid');
  },

  // ---- layers ----
  'layers.orthography': (s) => {
    const wl = wordLayer(s);
    if (wl?.config?.igt) delete wl.config.igt.orthographies;
    for (const d of docs(s)) {
      for (const t of tokensIn(d, 'word')) omitKeys(t.metadata, (k) => k.startsWith('orthog:'));
    }
  },
  'layers.ignoredTokensPunctuation': (s) => {
    const cfg = wordLayer(s)?.config?.igt;
    if (cfg?.ignoredTokens?.type === 'unicodePunctuation') delete cfg.ignoredTokens;
  },
  'layers.ignoredTokensLetterLike': (s) => {
    const rule = wordLayer(s)?.config?.igt?.ignoredTokens;
    if (rule?.whitelist) rule.whitelist = [];
  },
  'layers.ignoredTokensBlacklist': (s) => {
    const cfg = wordLayer(s)?.config?.igt;
    if (cfg?.ignoredTokens?.type === 'blacklist') delete cfg.ignoredTokens;
  },
  'layers.fieldLang': (s) => {
    for (const l of s.layers) if (l.key.startsWith('span:')) delete l.config?.igt?.lang;
  },
  'layers.fieldTagset': (s) => {
    for (const l of s.layers) if (l.key.startsWith('span:')) delete l.config?.igt?.tagset;
  },
  'layers.foreignTokenLayer': (s) =>
    removeLayers(s, (l) => l.key.startsWith('token:') && !IGT_ROLES.has(l.config?.plaid?.role)),
  'layers.unscopedSpanLayer': (s) =>
    removeLayers(s, (l) => l.key.startsWith('span:') && !l.config?.igt?.scope),
  'layers.relationLayer': (s) => removeLayers(s, (l) => l.key.startsWith('relation:')),
  'layers.fieldEmpty': (s) => {
    const used = new Set(allSpans(s).map(([, sp]) => sp.layer));
    removeLayers(s, (l) => l.key.startsWith('span:') && !!l.config?.igt?.scope && !used.has(l.key));
  },

  // ---- vocabularies ----
  'vocab.linked': (s) => {
    s.vocabularies = [];
    for (const d of docs(s)) d.links = [];
    removeComments(s, (c) => c.anchor.type === 'vocab-item');
  },
  'vocab.second': (s) => {
    const [first, ...rest] = vocabs(s);
    const gone = new Set(rest.map((v) => v.key));
    s.vocabularies = first ? [first] : [];
    for (const d of docs(s)) d.links = d.links.filter((l) => !gone.has(l.vocab));
  },
  'vocab.customField': (s) => {
    for (const v of vocabs(s)) {
      const fields = v.config?.igt?.fields || {};
      const custom = Object.keys(fields).filter(
        (n) => !CORE_ITEM_FIELDS.has(n.replace(/\s\([^()]+\)$/, '')),
      );
      for (const n of custom) delete fields[n];
      for (const it of v.items) omitKeys(it.metadata, (k) => custom.includes(k));
    }
  },
  'vocab.fieldNotInline': (s) => {
    for (const v of vocabs(s)) {
      for (const f of Object.values(v.config?.igt?.fields || {})) {
        if (f?.inline === false) f.inline = true;
      }
    }
  },
  'vocab.fieldTagset': (s) => {
    for (const v of vocabs(s))
      for (const f of Object.values(v.config?.igt?.fields || {})) delete f?.tagset;
  },
  'vocab.fieldLang': (s) => {
    for (const v of vocabs(s))
      for (const f of Object.values(v.config?.igt?.fields || {})) delete f?.lang;
  },
  'vocab.fieldMultilingual': (s) => {
    for (const v of vocabs(s)) {
      const fields = v.config?.igt?.fields || {};
      const multi = Object.keys(fields).filter((n) => !!fieldNameLang(n));
      for (const n of multi) delete fields[n];
      for (const it of v.items) omitKeys(it.metadata, (k) => multi.includes(k));
    }
  },
  // The field goes, and with it the values in it.
  'vocab.fieldItemRef': (s) => {
    for (const v of vocabs(s)) {
      const fields = v.config?.igt?.fields || {};
      const refs = Object.keys(fields).filter(
        (n) => fields[n]?.type === 'item' && !fields[n]?.many,
      );
      for (const n of refs) delete fields[n];
      for (const it of v.items) omitKeys(it.metadata, (k) => refs.includes(k));
    }
  },
  'vocab.fieldItemRefMany': (s) => {
    for (const v of vocabs(s)) {
      const fields = v.config?.igt?.fields || {};
      const refs = Object.keys(fields).filter((n) => fields[n]?.type === 'item' && fields[n]?.many);
      for (const n of refs) delete fields[n];
      for (const it of v.items) omitKeys(it.metadata, (k) => refs.includes(k));
    }
  },
  'vocab.fieldEntryScope': (s) => {
    for (const v of vocabs(s))
      for (const f of Object.values(v.config?.igt?.fields || {})) delete f?.scope;
  },
  'vocab.customTagset': (s) => {
    for (const v of vocabs(s)) omitKeys(v.config?.igt?.tagsets, (name) => name !== 'Status');
  },
  'vocab.foreignConfig': (s) => {
    for (const v of vocabs(s)) omitKeys(v.config, (ns) => ns !== 'igt');
  },
  'vocab.duplicateName': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'vocab.fieldAliasName': coveredBy('vocab.customField', 'an alias-named field is a custom field'),

  // ---- entries ----
  ...Object.fromEntries(
    ['gloss', 'pos', 'morphType', 'definition', 'status', 'lexemeForm'].map((f) => [
      `item.${f}`,
      (s) => {
        for (const it of items(s)) delete it.metadata?.[f];
      },
    ]),
  ),
  'item.customFieldValue': coveredBy('vocab.customField', 'the values go with the field'),
  'item.multilingualValue': coveredBy('vocab.fieldMultilingual', 'the values go with the field'),
  'item.itemRefValue': coveredBy('vocab.fieldItemRef', 'the values go with the field'),
  'item.itemRefManyValue': coveredBy('vocab.fieldItemRefMany', 'the values go with the field'),
  'item.sense': coveredBy('vocab.linked', 'only a format that loses every vocabulary loses senses'),
  'item.subsense': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses senses',
  ),
  'item.senseOrder': (s) => {
    for (const it of items(s)) delete it.metadata?.senseOrder;
  },
  'item.homonyms': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.homographNumber': (s) => {
    for (const it of items(s)) delete it.metadata?.homograph;
  },
  'item.exampleCorpus': removeExamples((e) => e && typeof e === 'object' && 'token' in e),
  'item.exampleText': removeExamples((e) => e && typeof e === 'object' && 'text' in e),
  'item.exampleStale': removeExamples(
    (e) => typeof e?.token === 'string' && e.token.startsWith('missing-token:'),
  ),
  'item.flexIdentity': (s) => {
    for (const it of items(s)) {
      delete it.metadata?.flexEntry;
      delete it.metadata?.flexSense;
    }
  },
  'item.provenance': (s) => {
    for (const it of items(s)) omitKeys(it.metadata, isProvKey);
  },
  'item.zeroMorph': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.unlinked': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.extraMetadata': (s) => {
    for (const v of vocabs(s)) {
      const declared = new Set(Object.keys(v.config?.igt?.fields || {}));
      for (const it of v.items) {
        omitKeys(
          it.metadata,
          (k) =>
            !declared.has(k) &&
            !RESERVED_ITEM_KEYS.has(k) &&
            !ITEM_STAMPS.has(k) &&
            !isProvKey(k) &&
            !CORE_ITEM_FIELDS.has(k),
        );
      }
    }
  },
  'item.markupChars': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.surroundingWhitespace': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.offTagset': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.formNormalization': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),
  'item.containerHeadword': coveredBy(
    'vocab.linked',
    'only a format that loses every vocabulary loses this',
  ),

  // ---- documents ----
  'document.metadataUnconfigured': (s) => {
    const on = new Set((s.config?.igt?.documentMetadata || []).map((f) => f.name));
    for (const d of docs(s)) {
      omitKeys(
        d.metadata,
        (k) => !on.has(k) && k !== 'plaid' && k !== 'speechDetection' && !DOCUMENT_STAMPS.has(k),
      );
    }
  },
  'document.textDirection': (s) => {
    for (const d of docs(s)) {
      if (d.metadata?.plaid) delete d.metadata.plaid.textDirection;
      pruneEmpty(d.metadata, 'plaid');
    }
  },
  'document.speechDetection': (s) => {
    for (const d of docs(s)) delete d.metadata?.speechDetection;
  },
  'document.media': (s) => {
    for (const d of docs(s)) d.media = null;
  },
  'document.noText': (s) => removeDocuments(s, (d) => baselineOf(d) == null),
  'document.partlyAligned': coveredBy(
    'alignment.times',
    'a document is partly aligned while it has segments',
  ),

  // ---- text ----
  'text.blankLine': coveredBy('token.sentence', 'the rebuilt baseline has no blank lines'),

  // ---- tokens ----
  'token.orthographyValue': (s) => {
    for (const d of docs(s)) {
      for (const t of tokensIn(d, 'word')) omitKeys(t.metadata, (k) => k.startsWith('orthog:'));
    }
  },
  'token.orthographyUnconfigured': (s) => {
    const names = new Set((wordLayer(s)?.config?.igt?.orthographies || []).map((o) => o.name));
    for (const d of docs(s)) {
      for (const t of tokensIn(d, 'word')) {
        omitKeys(t.metadata, (k) => k.startsWith('orthog:') && !names.has(k.slice(7)));
      }
    }
  },
  'token.wordExtraMetadata': (s) => {
    for (const d of docs(s)) {
      for (const t of tokensIn(d, 'word')) {
        omitKeys(t.metadata, (k) => !k.startsWith('orthog:') && !isProvKey(k));
      }
    }
  },
  'token.orphanMorpheme': (s) => {
    for (const d of docs(s)) {
      const words = new Set(tokensIn(d, 'word').map((w) => `${w.begin}-${w.end}`));
      removeTokens(s, d, (t) => t.layer === 'token:morpheme' && !words.has(`${t.begin}-${t.end}`));
    }
  },
  'token.provenance': (s) => {
    for (const d of docs(s)) {
      for (const t of [...tokensIn(d, 'sentence'), ...tokensIn(d, 'word')])
        removeProvFrom(t.metadata);
    }
  },
  'token.sentenceExtraMetadata': (s) => {
    for (const d of docs(s))
      for (const t of tokensIn(d, 'sentence')) omitKeys(t.metadata, (k) => !isProvKey(k));
  },
  'token.morphemeProvenance': (s) => {
    for (const d of docs(s)) for (const t of tokensIn(d, 'morpheme')) removeProvFrom(t.metadata);
  },
  'token.morphTypeOnMorpheme': (s) => {
    for (const d of docs(s)) for (const t of tokensIn(d, 'morpheme')) delete t.metadata.morphType;
  },

  // ---- time alignment ----
  'alignment.provenance': (s) => {
    for (const d of docs(s))
      for (const t of tokensIn(d, 'time-alignment')) removeProvFrom(t.metadata);
  },
  'alignment.times': (s) => {
    for (const d of docs(s)) removeTokens(s, d, (t) => t.layer === 'token:time-alignment');
  },
  'alignment.straddlesSentences': (s) => {
    for (const d of docs(s)) {
      const sentences = tokensIn(d, 'sentence');
      removeTokens(
        s,
        d,
        (a) =>
          a.layer === 'token:time-alignment' &&
          sentences.some((sn) => a.begin < sn.begin && sn.begin < a.end),
      );
    }
  },
  'alignment.speaker': (s) => {
    for (const d of docs(s))
      for (const t of tokensIn(d, 'time-alignment')) delete t.metadata.speaker;
  },
  'alignment.extraMetadata': (s) => {
    for (const d of docs(s)) {
      for (const t of tokensIn(d, 'time-alignment')) {
        omitKeys(
          t.metadata,
          (k) => !['timeBegin', 'timeEnd', 'speaker'].includes(k) && !isProvKey(k),
        );
      }
    }
  },
  'alignment.severalInSentence': coveredBy('alignment.times', 'a property of segments'),
  'alignment.mixedSpeakersInSentence': coveredBy('alignment.times', 'a property of segments'),
  'alignment.textAcrossLineBreak': coveredBy('alignment.times', 'a property of segments'),
  'alignment.notSentenceExtent': coveredBy('alignment.times', 'a property of segments'),
  'alignment.overlappingTimes': coveredBy('alignment.times', 'a property of segments'),

  // ---- annotations ----
  'span.multiToken': (s) => {
    for (const d of docs(s)) removeSpans(s, d, (sp) => sp.tokens.length > 1);
  },
  // The first annotation in a field on the same tokens, in server order, is
  // kept, and the second and on go.
  'span.duplicate': (s) => {
    for (const d of docs(s)) {
      const first = new Map();
      for (const sp of [...d.spans].sort(byOrder)) {
        const k = `${sp.layer}|${sp.tokens.join(',')}`;
        if (!first.has(k)) first.set(k, sp);
      }
      const kept = new Set(first.values());
      removeSpans(s, d, (sp) => !kept.has(sp));
    }
  },
  'span.onForeignLayer': coveredBy('layers.unscopedSpanLayer', 'the annotations go with the layer'),
  'span.onAlignment': (s) => {
    for (const d of docs(s)) {
      removeSpans(
        s,
        d,
        (sp) => sp.tokens.length > 0 && sp.tokens.every((k) => tokenRole(k, 'time-alignment')),
      );
    }
  },
  ...Object.fromEntries(
    ['machine', 'contributed', 'verified'].map((state) => [
      `span.prov${state[0].toUpperCase()}${state.slice(1)}`,
      (s) => {
        for (const [, sp] of allSpans(s))
          if (provState(sp.metadata) === state) removeProvFrom(sp.metadata);
      },
    ]),
  ),
  ...Object.fromEntries(
    ['provSource', 'provProb', 'provDetail'].map((k) => [
      `span.${k}`,
      (s) => {
        for (const [, sp] of allSpans(s)) delete sp.metadata[k];
      },
    ]),
  ),
  'span.extraMetadata': (s) => {
    for (const [, sp] of allSpans(s)) omitKeys(sp.metadata, (k) => !isProvKey(k));
  },
  'span.emptyValue': (s) => {
    for (const d of docs(s)) removeSpans(s, d, (sp) => sp.value === '');
  },
  'span.reachesOrphanToken': coveredBy(
    'token.orphanMorpheme',
    'the orphan goes, and a span on it with it',
  ),

  // ---- vocabulary links ----
  'link.word': (s) => {
    for (const d of docs(s))
      d.links = d.links.filter((l) => !(l.tokens.length === 1 && tokenRole(l.tokens[0], 'word')));
  },
  'link.morpheme': (s) => {
    for (const d of docs(s)) {
      d.links = d.links.filter(
        (l) => !(l.tokens.length === 1 && tokenRole(l.tokens[0], 'morpheme')),
      );
    }
  },
  'link.mwe': (s) => {
    for (const d of docs(s)) {
      const order = sortedLinks(d);
      d.links = d.links.filter(
        (l) => !(isMwe(l) && order(l).every((v, i, a) => i === 0 || v === a[i - 1] + 1)),
      );
    }
  },
  'link.mweDiscontinuous': (s) => {
    for (const d of docs(s)) {
      const order = sortedLinks(d);
      d.links = d.links.filter(
        (l) => !(isMwe(l) && order(l).some((v, i, a) => i > 0 && v !== a[i - 1] + 1)),
      );
    }
  },
  'link.onSentence': (s) => {
    for (const d of docs(s)) {
      d.links = d.links.filter(
        (l) => !(l.tokens.length > 0 && l.tokens.every((k) => tokenRole(k, 'sentence'))),
      );
    }
  },
  'link.onSegment': (s) => {
    for (const d of docs(s))
      d.links = d.links.filter((l) => !l.tokens.some((k) => tokenRole(k, 'time-alignment')));
  },
  'link.mweAcrossSentences': coveredBy(
    'link.mweDiscontinuous',
    'every link over words is removed by link.mwe or link.mweDiscontinuous',
  ),
  'link.duplicateOnToken': coveredBy('link.word', 'the links on a token go by their kind'),
  'link.toSense': coveredBy('link.word', 'the links go by their kind'),
  'link.secondVocabulary': coveredBy('link.word', 'the links go by their kind'),
  'link.onOrphanToken': coveredBy('link.morpheme', 'the links go by their kind'),
  'link.entryMorphType': coveredBy('link.morpheme', 'the links go by their kind'),
  ...Object.fromEntries(
    ['human', 'machine', 'contributed', 'verified'].map((state) => [
      `link.prov${state[0].toUpperCase()}${state.slice(1)}`,
      (s) => {
        for (const d of docs(s))
          for (const l of d.links) if (provState(l.metadata) === state) removeProvFrom(l.metadata);
      },
    ]),
  ),
  ...Object.fromEntries(
    ['provSource', 'provProb', 'provDetail'].map((k) => [
      `link.${k}`,
      (s) => {
        for (const d of docs(s)) for (const l of d.links) delete l.metadata[k];
      },
    ]),
  ),

  // ---- relations ----
  'relation.value': (s) => {
    for (const d of docs(s)) removeRelations(s, d, () => true);
  },

  // ---- comments ----
  'comment.document': removeCommentsOn((c) => c.anchor.type === 'document'),
  'comment.text': removeCommentsOn((c) => c.anchor.type === 'text'),
  'comment.sentence': removeCommentsOn(
    (c) => c.anchor.type === 'token' && tokenRole(c.anchor.ref, 'sentence'),
  ),
  'comment.word': removeCommentsOn(
    (c) => c.anchor.type === 'token' && tokenRole(c.anchor.ref, 'word'),
  ),
  'comment.morpheme': removeCommentsOn(
    (c) => c.anchor.type === 'token' && tokenRole(c.anchor.ref, 'morpheme'),
  ),
  'comment.segment': removeCommentsOn(
    (c) => c.anchor.type === 'token' && tokenRole(c.anchor.ref, 'time-alignment'),
  ),
  'comment.annotation': removeCommentsOn((c) => c.anchor.type === 'span'),
  'comment.entry': removeCommentsOn((c) => c.anchor.type === 'vocab-item'),
  'comment.relation': (s) => removeComments(s, (c) => c.anchor.type === 'relation'),
  'comment.orphaned': (s) => removeComments(s, (c) => c.anchor.ref == null),
  'comment.edited': (s) => {
    for (const c of [
      ...docs(s).flatMap((d) => d.comments),
      ...vocabs(s).flatMap((v) => v.comments || []),
    ]) {
      c.edited = false;
    }
  },
  'comment.anchorLabel': (s) => {
    for (const c of [
      ...docs(s).flatMap((d) => d.comments),
      ...vocabs(s).flatMap((v) => v.comments || []),
    ]) {
      c.anchorLabel = null;
    }
  },
  'comment.secondAuthor': coveredBy('comment.document', 'comments go by their anchor'),
  'comment.markdown': coveredBy('comment.document', 'comments go by their anchor'),

  // ---- guidelines ----
  'guideline.present': (s) => {
    s.guidelines = [];
  },
  'guideline.pinned': (s) => {
    for (const g of s.guidelines || []) g.pinned = false;
  },
  'guideline.emptyBody': (s) => {
    s.guidelines = (s.guidelines || []).filter((g) => g.body !== '');
  },
  'guideline.duplicateTitle': (s) => {
    const seen = new Set();
    s.guidelines = (s.guidelines || []).filter((g) => !seen.has(g.title) && seen.add(g.title));
  },
};

/** Whether a project's own ignored-tokens rule skips a word. */
export const isIgnored = (s, text) =>
  isTokenIgnored(text, wordLayer(s)?.config?.igt?.ignoredTokens ?? null);
