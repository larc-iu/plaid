// The lexicon half of the FLEx export target: the project's vocabularies as a
// LIFT file plus its .lift-ranges sidecar. .flextext carries texts but has no
// lexicon, and LIFT is FLEx's own lexicon interchange format, so a FLEx export
// is both files. Import the .lift FIRST so the entries exist, then the
// .flextext, whose <morph> citation forms match against them.
//
// Version 0.13 is deliberate: it is what FLEx reads and writes. (0.14 "never
// really saw use" per the standard's own migration stylesheet, and 0.15 renames
// <field type> to <field name>.) To validate, migrate the output forward with
// the standard's stylesheets and check the result against lift.rng:
//   xsltproc LIFT-0.13-0.14.xsl out.lift | xsltproc LIFT-0.14-0.15.xsl - > out15.lift
//   xmllint --noout --relaxng lift.rng out15.lift
//
// Vocab item → LIFT, the inverse of importLexicon (import/flex/importEngine.js):
//   item.form               → <citation> when a lexemeForm differs, else <lexical-unit>
//   metadata.lexemeForm     → <lexical-unit>
//   metadata.morphType      → <trait name="morph-type">        (entry)
//   metadata.homograph      → entry @order (the homograph number)
//   metadata.flexEntry      → entry @guid, so re-importing into the FLEx project
//                             the data came from MERGES instead of duplicating
//   metadata.flexSense      → sense @id
//   metadata.gloss (ru)     → <gloss lang="ru">                 (sense)
//   metadata.definition (…) → <definition><form lang=…>         (sense)
//   metadata.pos            → <grammatical-info value=…>        (sense)
//   metadata.examples       → <example><form>/<translation>     (sense)
//                             A promoted example is a {document, token}
//                             reference, so the sentence text comes from
//                             `exampleTexts`, keyed by exampleKey(); an
//                             imported FLEx example carries its own text.
//   a field of type `item`  → <relation type="<name>" ref=…>     (sense)
//   anything else           → <field type="<name>">             (sense)
// A headword and its senses become ONE entry with senses and subsenses, undoing
// the importer's item-per-sense flattening. A vocabulary built by hand has no
// such guids, so each of its items is an entry of its own.

import { xmlEscape } from './flextext.js';
import { allExamples, buildSenseTree, exampleKey } from '../domain/vocabDictionary.js';
import { readVocabFields } from '../domain/igtConfig.js';
import { FIELD_SCOPES, FIELD_TYPES } from '../domain/vocabFields.js';
import { FLEX_MORPH_TYPES } from '../domain/affixMarkers.js';

export const LIFT_VERSION = '0.13';

// Metadata keys this exporter reads structurally. Everything else an item
// carries becomes a <field>, so a hand-built vocabulary exports its own
// columns without any configuration.
// Entry-level keys the entry element carries itself, plus the structure keys
// the sense tree is built from and the import identity: none is a field.
const ENTRY_KEYS = new Set([
  'lexemeForm',
  'morphType',
  'homograph',
  'flexEntry',
  'flexSense',
  'parent',
  'senseOrder',
]);
const SENSE_KEYS = new Set(['pos', 'examples']);
// Multilingual bases: written bare for the primary writing system and
// suffixed for the others ("gloss", "gloss (ru)"). See fieldName() on the
// importer's side, which these two must stay in step with.
const SENSE_BASES = new Set(['gloss', 'definition']);

/**
 * Split a vocab field name into its base and writing system: "gloss (ru)" →
 * { base: 'gloss', ws: 'ru' }, "gloss" → { base: 'gloss', ws: null }. The lazy
 * base makes the LAST parenthesized group the writing system, so a field
 * genuinely named "Note (old)" keeps "Note" as its base, which is what the
 * importer meant by it in the first place.
 */
export function parseFieldName(name) {
  const m = /^(.*?)(?: \(([^()]+)\))?$/.exec(String(name ?? ''));
  return { base: m?.[1] ?? '', ws: m?.[2] ?? null };
}

const isId = (v) => typeof v === 'string' && v.trim() !== '';

// Only scalars become field text. A nested object would stringify to
// "[object Object]", which is worse than omitting it.
const scalar = (v) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

// ---- element builders (each returns [] or [lines]) -------------------------

const textEl = (indent, value) => `${indent}<text>${xmlEscape(value)}</text>`;

/**
 * A LIFT multitext: one <form> per writing system. Only one form per lang is
 * allowed in a parent, so the first value for a lang wins (the primary
 * writing system is emitted first, and a "gloss (en)" alongside a "gloss"
 * already resolved to `en` would otherwise make the file invalid).
 */
function multitext(indent, values) {
  const lines = [];
  const seen = new Set();
  for (const [lang, value] of values) {
    if (!lang || value == null || value === '' || seen.has(lang)) continue;
    seen.add(lang);
    lines.push(
      `${indent}<form lang="${xmlEscape(lang)}">`,
      textEl(`${indent}  `, value),
      `${indent}</form>`,
    );
  }
  return lines;
}

const wrap = (indent, tag, inner) =>
  inner.length ? [`${indent}<${tag}>`, ...inner, `${indent}</${tag}>`] : [];

const trait = (indent, name, value) =>
  `${indent}<trait name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`;

// ---- item metadata → the pieces of a sense ---------------------------------

/**
 * Bucket one item's metadata: glosses and definitions as [lang, text] pairs,
 * plus the leftover custom fields in their original order.
 *
 * The unsuffixed key is the primary writing system, whose language is the
 * preset's analysis tag rather than a FLEx writing-system code. That tag can
 * collide with a suffixed key's ("gloss" resolving to `en` next to a
 * "gloss (en)"), so the primary sorts first and wins the one-form-per-lang
 * dedupe. The suffixed key is the one that was renamed, not the other way
 * around.
 */
function partitionMetadata(metadata, analysisLang, refFields = new Set()) {
  const glosses = [];
  const definitions = [];
  const fields = [];
  const relations = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (ENTRY_KEYS.has(key) || SENSE_KEYS.has(key)) continue;
    // A reference field holds item ids, which are not text: it becomes a
    // <relation> per target, not a <field>.
    if (refFields.has(key)) {
      const targets = Array.isArray(value) ? value : value == null ? [] : [value];
      for (const target of targets) if (isId(target)) relations.push({ type: key, target });
      continue;
    }
    const text = scalar(value);
    if (text == null || text === '') continue;
    const { base, ws } = parseFieldName(key);
    if (SENSE_BASES.has(base)) {
      (base === 'gloss' ? glosses : definitions).push({ lang: ws ?? analysisLang, text, ws });
      continue;
    }
    fields.push({ base, ws, text });
  }
  const primaryFirst = (list) =>
    list
      .map((v, i) => [v, i])
      .sort(([a, ai], [b, bi]) => (a.ws == null ? 0 : 1) - (b.ws == null ? 0 : 1) || ai - bi)
      .map(([v]) => [v.lang, v.text]);
  return {
    glosses: primaryFirst(glosses),
    definitions: primaryFirst(definitions),
    fields,
    relations,
  };
}

/**
 * Custom fields grouped by base name, so "Comment" and "Comment (ru)" become
 * ONE <field type="Comment"> holding a form per writing system rather than two
 * fields whose names happen to differ. Each form's language is the key's own
 * suffix when it has one, else the writing system the vocabulary records for
 * that field (the FLEx importer stamps it for custom fields, which are
 * single-writing-system and carry no suffix), else the analysis language.
 */
function groupFields(fields, fieldLangs, analysisLang) {
  const byBase = new Map();
  for (const { base, ws, text } of fields) {
    const lang = ws ?? fieldLangs[base] ?? analysisLang;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push([lang, text]);
  }
  return byBase;
}

/**
 * The examples of one sense. Two kinds live in the same list, in the order the
 * user put them: a promoted example is a {document, token} reference whose
 * sentence is read from `ctx.exampleTexts`, and an imported FLEx example
 * carries its own text. A reference whose sentence is not there — the document
 * could not be read, or the token is gone — is counted in `ctx.unresolved` and
 * left out.
 */
function examplesXml(indent, item, ctx) {
  const lines = [];
  for (const ex of allExamples(item)) {
    const source = ex.document ? ctx.exampleTexts.get(exampleKey(ex.document, ex.token)) : ex;
    const text = scalar(source?.text);
    if (text == null || text === '') {
      if (ex.document) ctx.unresolved.count += 1;
      continue;
    }
    const inner = [
      ...multitext(`${indent}  `, [[ctx.vern, text]]),
      ...wrap(
        `${indent}  `,
        'translation',
        multitext(`${indent}    `, [[ctx.analysisLang, scalar(source?.translation)]]),
      ),
    ];
    lines.push(...wrap(indent, 'example', inner));
  }
  return lines;
}

/**
 * A sense's LIFT id: the FLEx sense guid it came from, else its place under
 * the id above it. `assignLiftIds` walks the same tree with the same formula,
 * so a relation can name a sense that is written later.
 */
const senseIdOf = (item, parentId, index) =>
  scalar(item?.metadata?.flexSense) ?? `${parentId}_${index + 1}`;

/**
 * <relation> per reference, deduplicated. A reference to an entry this export
 * left out has nothing to point at, so it is dropped.
 */
function relationsXml(indent, relations, ctx) {
  const lines = [];
  const seen = new Set();
  for (const { type, target } of relations) {
    const ref = ctx.liftIds.get(target);
    if (!ref || seen.has(`${type}|${ref}`)) continue;
    seen.add(`${type}|${ref}`);
    ctx.relationTypes.add(type);
    lines.push(`${indent}<relation type="${xmlEscape(type)}" ref="${xmlEscape(ref)}"/>`);
  }
  return lines;
}

// A sense, with its own senses nested as <subsense>. `tag` is 'sense' at the
// top and 'subsense' below; `index` numbers it among its siblings for the id.
function senseXml(indent, item, ctx, index, tag = 'sense', children = []) {
  const meta = item.metadata || {};
  const { glosses, definitions, fields, relations } = partitionMetadata(
    meta,
    ctx.analysisLang,
    ctx.refFields,
  );
  const grouped = groupFields(fields, ctx.fieldLangs, ctx.analysisLang);
  for (const base of grouped.keys()) ctx.customNames.add(base);

  const id = senseIdOf(item, ctx.entryId, index);
  const pos = scalar(meta.pos);
  const inner = [];
  if (pos != null && pos !== '') {
    inner.push(`${indent}  <grammatical-info value="${xmlEscape(pos)}"/>`);
    ctx.posValues.add(pos);
  }
  const seenGlossLangs = new Set();
  for (const [lang, text] of glosses) {
    if (seenGlossLangs.has(lang)) continue;
    seenGlossLangs.add(lang);
    inner.push(
      `${indent}  <gloss lang="${xmlEscape(lang)}">`,
      textEl(`${indent}    `, text),
      `${indent}  </gloss>`,
    );
  }
  inner.push(...wrap(`${indent}  `, 'definition', multitext(`${indent}    `, definitions)));
  // A headword-only reference belongs to the entry, and is written there.
  inner.push(
    ...relationsXml(
      `${indent}  `,
      relations.filter((r) => !ctx.entryRefFields.has(r.type)),
      ctx,
    ),
  );
  inner.push(...examplesXml(`${indent}  `, item, ctx));
  for (const [base, values] of grouped) {
    inner.push(
      `${indent}  <field type="${xmlEscape(base)}">`,
      ...multitext(`${indent}    `, values),
      `${indent}  </field>`,
    );
  }
  for (const [i, child] of children.entries()) {
    inner.push(
      ...senseXml(
        `${indent}  `,
        child.item,
        { ...ctx, entryId: id },
        i,
        'subsense',
        child.children,
      ),
    );
  }
  // An item with nothing but a form says nothing a sense could hold, and an
  // entry is allowed to have none. FLEx makes one on its own when it needs to.
  // Unless a reference names it, which would otherwise point at no element.
  if (!inner.length && !ctx.referenced.has(item.id)) return [];
  return [`${indent}<${tag} id="${xmlEscape(id)}">`, ...inner, `${indent}</${tag}>`];
}

/**
 * An entry's LIFT id: its headword and the id of the item it is. The FLEx
 * guid is NOT used here, though it is the obvious candidate: a lexicon
 * imported without Lexicography Mode has one item per FLEx SENSE, so several
 * entries share a guid and would share an id, which LIFT does not allow. The
 * guid still rides on the entry's `guid` attribute, which is what a FLEx
 * re-import merges on. Same formula in `assignLiftIds`.
 */
function entryIdOf(group) {
  const meta = group.head.metadata || {};
  const citation = scalar(group.head.form) ?? '';
  const headword = scalar(meta.lexemeForm) ?? citation;
  return `${citation || headword}_${group.head.id ?? group.key}`;
}

/**
 * Every item's LIFT id, before anything is written: a headword is referred to
 * by its ENTRY id, a sense by its sense id. Relations point backwards and
 * forwards alike, so they cannot be resolved as the file is built.
 */
function assignLiftIds(groups) {
  const ids = new Map();
  for (const group of groups) {
    const entryId = entryIdOf(group);
    ids.set(group.head.id, entryId);
    // The headword's own gloss is the entry's first sense, so its senses
    // start at index 1.
    const walk = (nodes, parentId, start) =>
      nodes.forEach((node, i) => {
        const id = senseIdOf(node.item, parentId, start + i);
        ids.set(node.item.id, id);
        walk(node.children, id, 0);
      });
    walk(group.senses, entryId, 1);
  }
  return ids;
}

function entryXml(indent, group, ctx) {
  const first = group.head;
  const meta = first.metadata || {};
  const guid = scalar(meta.flexEntry);
  const lexemeForm = scalar(meta.lexemeForm);
  const citation = scalar(first.form) ?? '';
  // The importer took the citation form as the item form and kept the lexeme
  // form aside only when the two differed, so put both back where they came from.
  const headword = lexemeForm ?? citation;
  const entryId = entryIdOf(group);
  const homograph = Number(meta.homograph);

  const attrs = [
    `id="${xmlEscape(entryId)}"`,
    ...(guid ? [`guid="${xmlEscape(guid)}"`] : []),
    ...(Number.isInteger(homograph) && homograph > 0 ? [`order="${homograph}"`] : []),
  ];

  const inner = [
    ...wrap(`${indent}  `, 'lexical-unit', multitext(`${indent}    `, [[ctx.vern, headword]])),
    ...(lexemeForm != null && citation !== '' && citation !== lexemeForm
      ? wrap(`${indent}  `, 'citation', multitext(`${indent}    `, [[ctx.vern, citation]]))
      : []),
  ];
  const morphType = scalar(meta.morphType);
  if (morphType && FLEX_MORPH_TYPES.includes(morphType)) {
    inner.push(trait(`${indent}  `, 'morph-type', morphType));
  }
  // Headword-only references are the entry's, wherever in the group they sit.
  inner.push(
    ...relationsXml(
      `${indent}  `,
      group.items.flatMap((it) =>
        partitionMetadata(it.metadata, ctx.analysisLang, ctx.refFields).relations.filter((r) =>
          ctx.entryRefFields.has(r.type),
        ),
      ),
      ctx,
    ),
  );
  const senseCtx = { ...ctx, entryId };
  let senses = 0;
  // A headword that stands over senses and says nothing of its own is not one
  // of them: writing it as the first sense puts a gloss-less sense in front of
  // every real one, and re-importing that adds a spurious sense every round.
  // Its own fields are the entry's, and go after the senses.
  const headParts = partitionMetadata(meta, ctx.analysisLang, ctx.refFields);
  const headIsASense =
    !group.senses.length ||
    headParts.glosses.length > 0 ||
    headParts.definitions.length > 0 ||
    (scalar(meta.pos) ?? '') !== '' ||
    headParts.relations.some((r) => !ctx.entryRefFields.has(r.type)) ||
    examplesXml(`${indent}    `, first, senseCtx).length > 0;
  const trailing = [];
  if (!headIsASense) {
    const grouped = groupFields(headParts.fields, ctx.fieldLangs, ctx.analysisLang);
    for (const [base, values] of grouped) {
      ctx.customNames.add(base);
      trailing.push(
        `${indent}  <field type="${xmlEscape(base)}">`,
        ...multitext(`${indent}    `, values),
        `${indent}  </field>`,
      );
    }
  }
  // The headword's own gloss, if any, is the first sense; its senses follow,
  // each with its own senses nested inside it.
  const top = [{ item: first, children: [] }, ...group.senses];
  top.forEach((node, i) => {
    if (i === 0 && !headIsASense) return;
    const lines = senseXml(`${indent}  `, node.item, senseCtx, i, 'sense', node.children);
    // Count what was written: a sense with nothing to say is left out.
    senses += lines.filter((l) => /^\s*<(sub)?sense /.test(l)).length;
    inner.push(...lines);
  });
  inner.push(...trailing);
  return {
    lines: [`${indent}<entry ${attrs.join(' ')}>`, ...inner, `${indent}</entry>`],
    senses,
  };
}

// ---- grouping --------------------------------------------------------------

/**
 * Items → entry groups, from the vocabulary's own sense tree and nothing
 * else: every headword is an entry, its senses its senses, theirs subsenses.
 * `{key, head, senses: [{item, children}], items}` per group, `items` being
 * every item in it, headword first, depth-first.
 */
export function groupEntries(vocabularies) {
  const groups = [];
  for (const vocab of vocabularies || []) {
    const tree = buildSenseTree(vocab.items || []);
    const node = (it) => ({
      item: it,
      children: (tree.childrenOf.get(it.id) || []).map(node),
    });
    const flat = (nodes) => nodes.flatMap((n) => [n.item, ...flat(n.children)]);
    for (const head of tree.roots) {
      const senses = (tree.childrenOf.get(head.id) || []).map(node);
      groups.push({ key: `${vocab.id}:${head.id}`, head, senses, items: [head, ...flat(senses)] });
    }
  }
  return groups;
}

/**
 * Every promoted example reference in these vocabularies, deduplicated. The
 * caller reads the sentences out of the documents they point into and hands
 * them back to `buildLiftLexicon` as `exampleTexts`; nothing here fetches.
 */
export function collectExampleRefs(vocabularies) {
  const seen = new Set();
  const refs = [];
  for (const vocab of vocabularies || []) {
    for (const item of vocab.items || []) {
      for (const ex of allExamples(item)) {
        if (!ex.document) continue;
        const key = exampleKey(ex.document, ex.token);
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ document: ex.document, token: ex.token });
      }
    }
  }
  return refs;
}

// ---- the files -------------------------------------------------------------

/**
 * The ranges the file uses: `grammatical-info` for the categories, so a FLEx
 * import creates them rather than guessing, and `lexical-relation` for the
 * reference fields that became relations. Morph types are a FLEx builtin list
 * and need no range.
 */
function rangesXml(ranges, analysisLang) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<lift-ranges>'];
  for (const [id, values] of ranges) {
    lines.push(`  <range id="${xmlEscape(id)}">`);
    for (const value of [...values].sort()) {
      lines.push(
        `    <range-element id="${xmlEscape(value)}">`,
        ...wrap('      ', 'label', multitext('        ', [[analysisLang, value]])),
        '    </range-element>',
      );
    }
    lines.push('  </range>');
  }
  lines.push('</lift-ranges>', '');
  return lines.join('\n');
}

/**
 * vocabularies: [{ id, name, items: [{ id, form, metadata }] }]
 * options: the FLEx preset's options — langs.baseline is the vernacular
 *   writing system, langs.analysis the default for glosses and definitions.
 * rangesHref: the .lift-ranges filename to point the header at (null to omit
 *   the ranges header, e.g. when no category is used anywhere).
 * exampleTexts: Map from exampleKey(document, token) to { text, translation },
 *   the sentences behind the promoted examples (see collectExampleRefs).
 *
 * @returns {{ lift: string, ranges: string|null, entryCount: number,
 *             senseCount: number, warnings: string[] }}
 */
export function buildLiftLexicon({
  vocabularies = [],
  options = {},
  rangesHref = null,
  exampleTexts = new Map(),
}) {
  const vern = options?.langs?.baseline || 'und';
  const analysisLang = options?.langs?.analysis || 'en';
  // A vocabulary can say which writing system a field is in (config.igt.fields
  // <name>.lang). Merged across vocabularies: a name shared by two lexicons is
  // the same field for LIFT's purposes.
  const fieldLangs = {};
  // The reference fields, by name, merged the same way: their values are item
  // ids and become <relation>s rather than text.
  const refFields = new Set();
  // …and which of those are the entry's own rather than a sense's.
  const entryRefFields = new Set();
  for (const vocab of vocabularies) {
    for (const [name, spec] of Object.entries(readVocabFields(vocab?.config) ?? {})) {
      if (typeof spec?.lang === 'string' && spec.lang !== '') fieldLangs[name] = spec.lang;
      if (spec?.type !== FIELD_TYPES.ITEM) continue;
      refFields.add(name);
      if (spec.scope === FIELD_SCOPES.ENTRY) entryRefFields.add(name);
    }
  }
  const allGroups = groupEntries(vocabularies);
  // An entry with no form at all has nothing to be looked up by, and FLEx
  // would reject it. Drop it rather than write an empty headword, and say so.
  // Dropped before the ids are handed out, so no relation can name one.
  const groups = allGroups.filter((g) => g.items.some((i) => scalar(i.form)));
  const formless = allGroups.length - groups.length;
  // Every item a reference names. An empty sense is written anyway when
  // something points at it, since the alternative is a ref naming nothing.
  const referenced = new Set();
  for (const g of groups) {
    for (const it of g.items) {
      for (const r of partitionMetadata(it.metadata, analysisLang, refFields).relations) {
        referenced.add(r.target);
      }
    }
  }
  const ctx = {
    referenced,
    vern,
    analysisLang,
    fieldLangs,
    refFields,
    entryRefFields,
    liftIds: assignLiftIds(groups),
    relationTypes: new Set(),
    posValues: new Set(),
    customNames: new Set(),
    exampleTexts,
    unresolved: { count: 0 },
  };
  const warnings = [];

  const entries = [];
  let senseCount = 0;
  for (const group of groups) {
    const { lines, senses } = entryXml('  ', group, ctx);
    entries.push(...lines);
    senseCount += senses;
  }
  if (formless > 0) {
    warnings.push(
      `${formless} lexicon ${formless === 1 ? 'item has' : 'items have'} no form and ${
        formless === 1 ? 'was' : 'were'
      } left out of the .lift file.`,
    );
  }

  if (ctx.unresolved.count > 0) {
    const n = ctx.unresolved.count;
    warnings.push(
      `${n} example${n === 1 ? '' : 's'} could not be read from the document ${
        n === 1 ? 'it points' : 'they point'
      } into and ${n === 1 ? 'was' : 'were'} left out of the .lift file.`,
    );
  }

  const declared = [
    ...(ctx.posValues.size ? [['grammatical-info', ctx.posValues]] : []),
    ...(ctx.relationTypes.size ? [['lexical-relation', ctx.relationTypes]] : []),
  ];
  const ranges = declared.length ? rangesXml(declared, analysisLang) : null;
  const header = [];
  if (ranges && rangesHref) {
    header.push(
      '    <ranges>',
      ...declared.map(
        ([id]) => `      <range id="${xmlEscape(id)}" href="${xmlEscape(rangesHref)}"/>`,
      ),
      '    </ranges>',
    );
  }
  if (ctx.customNames.size) {
    // Field definitions are descriptive: the <field type> instances carry the
    // data. FLEx decides for itself whether an unrecognized one lands in a
    // custom field or in import residue.
    header.push('    <fields>');
    for (const name of [...ctx.customNames].sort()) {
      header.push(
        `      <field tag="${xmlEscape(name)}">`,
        ...multitext('        ', [[analysisLang, `${name}, exported from Plaid.`]]),
        '      </field>',
      );
    }
    header.push('    </fields>');
  }

  const lift = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<lift version="${LIFT_VERSION}" producer="plaid-igt">`,
    ...wrap('  ', 'header', header),
    ...entries,
    '</lift>',
    '',
  ].join('\n');

  return {
    lift,
    ranges,
    entryCount: groups.length,
    senseCount,
    warnings,
  };
}
