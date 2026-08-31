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
//   anything else           → <field type="<name>">             (sense)
// Items sharing a flexEntry guid become ONE entry with several senses, undoing
// the importer's item-per-sense flattening. A vocabulary built by hand has no
// such guids, so each of its items is an entry of its own.

import { xmlEscape } from './flextext.js';
import { FLEX_MORPH_TYPES } from '../domain/affixMarkers.js';

export const LIFT_VERSION = '0.13';

// Metadata keys this exporter reads structurally. Everything else an item
// carries becomes a <field>, so a hand-built vocabulary exports its own
// columns without any configuration.
const ENTRY_KEYS = new Set(['lexemeForm', 'morphType', 'homograph', 'flexEntry', 'flexSense']);
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

const isStructural = (key) => {
  if (ENTRY_KEYS.has(key) || SENSE_KEYS.has(key)) return true;
  return SENSE_BASES.has(parseFieldName(key).base);
};

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
function partitionMetadata(metadata, analysisLang) {
  const glosses = [];
  const definitions = [];
  const fields = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (ENTRY_KEYS.has(key) || SENSE_KEYS.has(key)) continue;
    const text = scalar(value);
    if (text == null || text === '') continue;
    const { base, ws } = parseFieldName(key);
    if (SENSE_BASES.has(base)) {
      (base === 'gloss' ? glosses : definitions).push({ lang: ws ?? analysisLang, text, ws });
      continue;
    }
    fields.push([key, text]);
  }
  const primaryFirst = (list) =>
    list
      .map((v, i) => [v, i])
      .sort(([a, ai], [b, bi]) => (a.ws == null ? 0 : 1) - (b.ws == null ? 0 : 1) || ai - bi)
      .map(([v]) => [v.lang, v.text]);
  return { glosses: primaryFirst(glosses), definitions: primaryFirst(definitions), fields };
}

function examplesXml(indent, examples, vern, analysisLang) {
  if (!Array.isArray(examples)) return [];
  const lines = [];
  for (const ex of examples) {
    const text = scalar(ex?.text);
    if (text == null || text === '') continue;
    const inner = [
      ...multitext(`${indent}  `, [[vern, text]]),
      ...wrap(
        `${indent}  `,
        'translation',
        multitext(`${indent}    `, [[analysisLang, scalar(ex?.translation)]]),
      ),
    ];
    lines.push(...wrap(indent, 'example', inner));
  }
  return lines;
}

function senseXml(indent, item, ctx, index) {
  const meta = item.metadata || {};
  const { glosses, definitions, fields } = partitionMetadata(meta, ctx.analysisLang);
  for (const [name] of fields) ctx.customNames.add(name);

  const id = scalar(meta.flexSense) ?? `${ctx.entryId}_${index + 1}`;
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
  inner.push(...examplesXml(`${indent}  `, meta.examples, ctx.vern, ctx.analysisLang));
  for (const [name, text] of fields) {
    inner.push(
      `${indent}  <field type="${xmlEscape(name)}">`,
      ...multitext(`${indent}    `, [[ctx.analysisLang, text]]),
      `${indent}  </field>`,
    );
  }
  // An item with nothing but a form says nothing a sense could hold, and an
  // entry is allowed to have none. FLEx makes one on its own when it needs to.
  if (!inner.length) return [];
  return [`${indent}<sense id="${xmlEscape(id)}">`, ...inner, `${indent}</sense>`];
}

function entryXml(indent, group, ctx) {
  const first = group.items[0];
  const meta = first.metadata || {};
  const guid = scalar(meta.flexEntry);
  const lexemeForm = scalar(meta.lexemeForm);
  const citation = scalar(first.form) ?? '';
  // The importer took the citation form as the item form and kept the lexeme
  // form aside only when the two differed, so put both back where they came from.
  const headword = lexemeForm ?? citation;
  const entryId = `${citation || headword}_${guid ?? first.id ?? group.key}`;
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
  const senseCtx = { ...ctx, entryId };
  let senses = 0;
  group.items.forEach((item, i) => {
    const lines = senseXml(`${indent}  `, item, senseCtx, i);
    if (lines.length) senses += 1;
    inner.push(...lines);
  });
  return {
    lines: [`${indent}<entry ${attrs.join(' ')}>`, ...inner, `${indent}</entry>`],
    senses,
  };
}

// ---- grouping --------------------------------------------------------------

/**
 * Items → entry groups. Items of the same vocabulary sharing a flexEntry guid
 * rejoin as one entry (senses in item order). Everything else stands alone.
 * The guid is scoped by vocabulary: two vocabularies imported from the same
 * FLEx project would otherwise collapse into each other.
 */
export function groupEntries(vocabularies) {
  const groups = new Map();
  for (const vocab of vocabularies || []) {
    for (const item of vocab.items || []) {
      const guid = item.metadata?.flexEntry;
      const key = guid ? `${vocab.id}:${guid}` : `${vocab.id}:item:${item.id}`;
      const found = groups.get(key);
      if (found) found.items.push(item);
      else groups.set(key, { key, items: [item] });
    }
  }
  return [...groups.values()];
}

// ---- the files -------------------------------------------------------------

/**
 * The `grammatical-info` range, so the categories a FLEx import needs to
 * create are declared rather than guessed at. Morph types are a FLEx builtin
 * list and need no range.
 */
function rangesXml(posValues, analysisLang) {
  const values = [...posValues].sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<lift-ranges>',
    '  <range id="grammatical-info">',
  ];
  for (const value of values) {
    lines.push(
      `    <range-element id="${xmlEscape(value)}">`,
      ...wrap('      ', 'label', multitext('        ', [[analysisLang, value]])),
      '    </range-element>',
    );
  }
  lines.push('  </range>', '</lift-ranges>', '');
  return lines.join('\n');
}

/**
 * vocabularies: [{ id, name, items: [{ id, form, metadata }] }]
 * options: the FLEx preset's options — langs.baseline is the vernacular
 *   writing system, langs.analysis the default for glosses and definitions.
 * rangesHref: the .lift-ranges filename to point the header at (null to omit
 *   the ranges header, e.g. when no category is used anywhere).
 *
 * @returns {{ lift: string, ranges: string|null, entryCount: number,
 *             senseCount: number, warnings: string[] }}
 */
export function buildLiftLexicon({ vocabularies = [], options = {}, rangesHref = null }) {
  const vern = options?.langs?.baseline || 'und';
  const analysisLang = options?.langs?.analysis || 'en';
  const ctx = { vern, analysisLang, posValues: new Set(), customNames: new Set() };
  const warnings = [];

  const groups = groupEntries(vocabularies);
  const entries = [];
  let senseCount = 0;
  let formless = 0;
  for (const group of groups) {
    // An entry with no form at all has nothing to be looked up by, and FLEx
    // would reject it. Drop it rather than write an empty headword, and say so.
    const hasForm = group.items.some((i) => scalar(i.form));
    if (!hasForm) {
      formless += 1;
      continue;
    }
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

  const ranges = ctx.posValues.size ? rangesXml(ctx.posValues, analysisLang) : null;
  const header = [];
  if (ranges && rangesHref) {
    header.push(
      '    <ranges>',
      `      <range id="grammatical-info" href="${xmlEscape(rangesHref)}"/>`,
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
    entryCount: groups.length - formless,
    senseCount,
    warnings,
  };
}
