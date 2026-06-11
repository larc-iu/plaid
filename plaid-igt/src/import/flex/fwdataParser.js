// FLEx .fwdata parser — streaming pass over the FieldWorks LCM XML that keeps
// only the object classes the IGT import needs, then assembles a neutral IR.
//
// The fwdata format is a flat list of <rt class="..." guid="..."> elements
// cross-referenced by guid (ownership via ownerguid + <objsur t="o">, plain
// references via <objsur t="r">). A 60MB file is mostly scripture-checking
// noise (ChkRef etc.), so we filter by class during the stream and never
// hold the full document tree.
//
// All strings are normalized to NFC here (FieldWorks historically stores NFD;
// plaid projects want NFC so later hand-typed text matches imported forms).
// Segment BeginOffsets are translated into NFC space and remain UTF-16 code
// units relative to their paragraph; buildDocuments converts to code points.

import { SaxesParser } from 'saxes';

/** rt classes retained during the streaming pass. */
const KEEP_CLASSES = new Set([
  'LangProject',
  'Text', 'StText', 'StTxtPara', 'Segment', 'Note',
  'WfiWordform', 'WfiAnalysis', 'WfiGloss', 'WfiMorphBundle', 'PunctuationForm',
  'LexEntry', 'LexSense',
  'MoStemAllomorph', 'MoAffixAllomorph',
  'MoStemMsa', 'MoInflAffMsa', 'MoDerivAffMsa', 'MoUnclassifiedAffixMsa',
  'PartOfSpeech', 'MoMorphType', 'CmPossibility',
]);

const nfc = (s) => (s == null ? s : s.normalize('NFC'));

// --- lightweight tree helpers (nodes: {tag, attrs, children, text}) ---------

const child = (n, tag) => n?.children.find((c) => c.tag === tag) ?? null;
const refGuids = (n, tag) =>
  child(n, tag)?.children.filter((c) => c.tag === 'objsur').map((c) => c.attrs.guid) ?? [];
const refGuid = (n, tag) => refGuids(n, tag)[0] ?? null;
const valAttr = (n, tag) => child(n, tag)?.attrs.val ?? null;

/** <X><AUni ws="en">text</AUni>…</X> → {en: 'text', …} (NFC), or null. */
function multiUni(n, tag) {
  const el = child(n, tag);
  if (!el) return null;
  const out = {};
  for (const a of el.children) {
    if (a.tag === 'AUni' && a.text.trim() !== '') out[a.attrs.ws] = nfc(a.text);
  }
  return Object.keys(out).length ? out : null;
}

const runText = (el) =>
  el.children.filter((c) => c.tag === 'Run').map((c) => c.text).join('');

/** <X><AStr ws="en"><Run …>text</Run>…</AStr>…</X> → {en: 'text', …} (NFC), or null. */
function multiStr(n, tag) {
  const el = child(n, tag);
  if (!el) return null;
  const out = {};
  for (const a of el.children) {
    if (a.tag !== 'AStr') continue;
    const t = runText(a);
    if (t.trim() !== '') out[a.attrs.ws] = nfc(t);
  }
  return Object.keys(out).length ? out : null;
}

/** <X><Str><Run …>text</Run>…</Str></X> → 'text' (NFC, runs concatenated), or null. */
function str(n, tag) {
  const el = child(child(n, tag), 'Str');
  return el ? nfc(runText(el)) : null;
}

// --- streaming pass ---------------------------------------------------------

/**
 * Single pass over the XML. Returns {version, byGuid, byClass, customFields}.
 * byGuid/byClass hold raw element trees for KEEP_CLASSES rt elements only.
 */
function streamCollect(xml) {
  const parser = new SaxesParser();
  const byGuid = new Map();
  const byClass = new Map();
  const customFields = [];
  let version = null;
  let depth = 0;
  let capture = null; // root node of the rt currently being captured
  let stack = [];

  parser.on('error', (e) => {
    throw new Error(`fwdata XML parse error: ${e.message}`);
  });
  parser.on('opentag', (node) => {
    depth += 1;
    if (capture) {
      const n = { tag: node.name, attrs: node.attributes, children: [], text: '' };
      stack[stack.length - 1].children.push(n);
      stack.push(n);
      return;
    }
    if (depth === 1) {
      version = node.attributes.version ?? null;
    } else if (depth === 2) {
      if (node.name === 'rt' && KEEP_CLASSES.has(node.attributes.class)) {
        capture = { tag: 'rt', attrs: node.attributes, children: [], text: '' };
        stack = [capture];
      } else if (node.name === 'AdditionalFields') {
        capture = { tag: 'AdditionalFields', attrs: {}, children: [], text: '' };
        stack = [capture];
      }
    }
  });
  parser.on('text', (t) => {
    if (capture && stack.length) stack[stack.length - 1].text += t;
  });
  parser.on('closetag', () => {
    depth -= 1;
    if (!capture) return;
    stack.pop();
    if (stack.length === 0) {
      if (capture.tag === 'AdditionalFields') {
        for (const c of capture.children) {
          if (c.tag === 'CustomField') customFields.push({ ...c.attrs });
        }
      } else {
        const cls = capture.attrs.class;
        byGuid.set(capture.attrs.guid, capture);
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push(capture);
      }
      capture = null;
    }
  });

  parser.write(xml).close();
  return { version, byGuid, byClass, customFields };
}

// --- IR assembly -------------------------------------------------------------

/** Pick the English value of a multilingual map, else the first value. */
export const pickEn = (m) => (m == null ? null : m.en ?? Object.values(m)[0] ?? null);

/**
 * Parse a .fwdata XML string into the neutral FLEx IR.
 *
 * Returns {
 *   version, writingSystems: {vernacular, analysis},
 *   wsUsage: {wordForms, wordGloss, morphGloss, freeTranslation, literalTranslation, note},
 *   texts, lexicon, morphTypes, customFields, warnings
 * }
 */
export function parseFwdata(xml) {
  const { version, byGuid, byClass, customFields } = streamCollect(xml);
  const warnings = [];
  const cls = (name) => byClass.get(name) ?? [];
  const get = (guid, why) => {
    const n = guid == null ? null : byGuid.get(guid);
    if (guid != null && !n && why) warnings.push(`missing ${why} object ${guid}`);
    return n ?? null;
  };

  // Writing systems (space-separated ws-tag lists on the language project)
  const lp = cls('LangProject')[0] ?? null;
  const wsList = (tag, fallbackTag) => {
    const el = child(child(lp, tag), 'Uni') ?? child(child(lp, fallbackTag), 'Uni');
    return el?.text ? el.text.trim().split(/\s+/) : [];
  };
  const writingSystems = {
    vernacular: wsList('CurVernWss', 'VernWss'),
    analysis: wsList('CurAnalysisWss', 'AnalysisWss'),
  };

  // Shared lookups
  const posAbbrev = (guid) => {
    const p = get(guid, guid && 'PartOfSpeech');
    if (!p) return null;
    return pickEn(multiUni(p, 'Abbreviation')) ?? pickEn(multiUni(p, 'Name'));
  };
  const morphTypeName = (guid) => {
    const m = guid == null ? null : byGuid.get(guid);
    return m ? pickEn(multiUni(m, 'Name')) : null;
  };
  const msaPos = (guid) => {
    const msa = guid == null ? null : byGuid.get(guid);
    if (!msa) return null;
    return posAbbrev(
      refGuid(msa, 'PartOfSpeech') ?? refGuid(msa, 'ToPartOfSpeech') ?? refGuid(msa, 'FromPartOfSpeech'),
    );
  };
  // Allomorphs: MoStemAllomorph + MoAffixAllomorph, owner is the LexEntry
  const allomorphs = new Map();
  for (const a of [...cls('MoStemAllomorph'), ...cls('MoAffixAllomorph')]) {
    allomorphs.set(a.attrs.guid, {
      forms: multiUni(a, 'Form'),
      morphType: morphTypeName(refGuid(a, 'MorphType')),
      entryGuid: a.attrs.ownerguid ?? null,
    });
  }

  // ws usage tracking (drives which fields/orthographies the import offers)
  const usage = {
    wordForms: new Set(), wordGloss: new Set(), morphGloss: new Set(),
    freeTranslation: new Set(), literalTranslation: new Set(), note: new Set(),
  };
  const track = (set, m) => { for (const ws of Object.keys(m ?? {})) set.add(ws); };

  // Senses (entries may own subsenses recursively)
  const senseOf = (guid) => {
    const s = get(guid, 'LexSense');
    if (!s) return null;
    return {
      guid,
      gloss: multiUni(s, 'Gloss'),
      definition: multiStr(s, 'Definition'),
      pos: msaPos(refGuid(s, 'MorphoSyntaxAnalysis')),
    };
  };

  // Morpheme bundles
  const bundleOf = (guid) => {
    const b = get(guid, 'WfiMorphBundle');
    if (!b) return null;
    const allo = refGuid(b, 'Morph') ? allomorphs.get(refGuid(b, 'Morph')) : null;
    const senseGuid = refGuid(b, 'Sense');
    const sense = senseGuid ? senseOf(senseGuid) : null;
    const forms = multiStr(b, 'Form') ?? allo?.forms ?? null;
    const gloss = sense?.gloss ?? null;
    track(usage.morphGloss, gloss);
    return {
      forms,
      gloss,
      pos: msaPos(refGuid(b, 'Msa')) ?? sense?.pos ?? null,
      morphType: allo?.morphType ?? null,
      senseGuid,
      entryGuid: allo?.entryGuid ?? null,
    };
  };

  // A segment analysis ref → word or punctuation item
  const analysisItem = (guid) => {
    const n = get(guid, 'segment analysis');
    if (!n) return null;
    const kind = n.attrs.class;
    if (kind === 'PunctuationForm') return { kind: 'punct', form: str(n, 'Form') ?? '' };
    let gloss = null;
    let analysis = null;
    let wordform = null;
    if (kind === 'WfiGloss') {
      gloss = multiUni(n, 'Form');
      analysis = get(n.attrs.ownerguid, 'WfiAnalysis');
      wordform = analysis && get(analysis.attrs.ownerguid, 'WfiWordform');
    } else if (kind === 'WfiAnalysis') {
      analysis = n;
      wordform = get(n.attrs.ownerguid, 'WfiWordform');
    } else if (kind === 'WfiWordform') {
      wordform = n;
    } else {
      warnings.push(`unexpected analysis class ${kind} (${guid})`);
      return null;
    }
    if (!wordform) return null;
    const forms = multiUni(wordform, 'Form');
    track(usage.wordForms, forms);
    track(usage.wordGloss, gloss);
    return {
      kind: 'word',
      forms,
      gloss,
      pos: analysis ? posAbbrev(refGuid(analysis, 'Category')) : null,
      morphemes: analysis
        ? refGuids(analysis, 'MorphBundles').map(bundleOf).filter(Boolean)
        : null,
    };
  };

  // Texts → paragraphs → segments
  const texts = [];
  for (const t of cls('Text')) {
    const stText = get(refGuid(t, 'Contents'), null);
    const paragraphs = [];
    for (const pGuid of stText ? refGuids(stText, 'Paragraphs') : []) {
      const p = get(pGuid, 'StTxtPara');
      if (!p) continue;
      const rawContent = str(p, 'Contents') ?? '';
      // str() already returns NFC; recover raw for offset translation only if needed
      const rawForOffsets = runText(child(child(p, 'Contents'), 'Str') ?? { children: [] });
      const segments = [];
      for (const sGuid of refGuids(p, 'Segments')) {
        const s = get(sGuid, 'Segment');
        if (!s) continue;
        const rawBegin = Number(valAttr(s, 'BeginOffset') ?? 0);
        // FLEx computes offsets on NFD strings (LCM works in NFD internally)
        // even though fwdata serializes text as NFC — e.g. "й" counts as 2
        // units in BeginOffset but is 1 char in the stored Contents. Take the
        // prefix in NFD space, then measure it in NFC space.
        const beginOffset = nfc(rawForOffsets.normalize('NFD').slice(0, rawBegin)).length;
        const freeTranslation = multiStr(s, 'FreeTranslation');
        const literalTranslation = multiStr(s, 'LiteralTranslation');
        const notes = refGuids(s, 'Notes')
          .map((g) => multiStr(get(g, 'Note'), 'Content'))
          .filter(Boolean);
        track(usage.freeTranslation, freeTranslation);
        track(usage.literalTranslation, literalTranslation);
        for (const note of notes) track(usage.note, note);
        segments.push({
          guid: sGuid,
          beginOffset,
          freeTranslation,
          literalTranslation,
          notes,
          analyses: refGuids(s, 'Analyses').map(analysisItem).filter(Boolean),
        });
      }
      paragraphs.push({
        guid: pGuid,
        content: rawContent,
        parseIsCurrent: valAttr(p, 'ParseIsCurrent') === 'True',
        segments,
      });
    }
    texts.push({
      guid: t.attrs.guid,
      names: multiUni(t, 'Name'),
      source: multiStr(t, 'Source'),
      description: multiStr(t, 'Description'),
      genres: refGuids(t, 'Genres')
        .map((g) => pickEn(multiUni(byGuid.get(g), 'Name')))
        .filter(Boolean),
      paragraphs,
    });
  }

  // Lexicon: every entry, senses flattened (subsenses included, depth-first)
  const lexicon = [];
  for (const e of cls('LexEntry')) {
    const lf = allomorphs.get(refGuid(e, 'LexemeForm')) ?? null;
    const senses = [];
    const walkSenses = (owner) => {
      for (const sGuid of refGuids(owner, 'Senses')) {
        const sNode = get(sGuid, 'LexSense');
        if (!sNode) continue;
        const s = senseOf(sGuid);
        if (s) senses.push(s);
        walkSenses(sNode);
      }
    };
    walkSenses(e);
    lexicon.push({
      guid: e.attrs.guid,
      forms: lf?.forms ?? null,
      citationForm: multiUni(e, 'CitationForm'),
      morphType: lf?.morphType ?? null,
      homograph: Number(valAttr(e, 'HomographNumber') ?? 0),
      senses,
    });
  }

  return {
    version,
    writingSystems,
    wsUsage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, [...v]])),
    texts,
    lexicon,
    customFields,
    warnings,
  };
}
