// The vocabulary-TSV round-trip expectation: what its loss list says Bulk Add
// gives back, as edits to the snapshots (see ./index.js).
//
// A vocabulary TSV holds one vocabulary's entries and nothing else, so almost
// the whole catalog is out of the file: one strip takes the documents, layers
// and project settings off the expected side, and what is left is the entries.
// The run (e2e/fidelity/vocabTsv.mjs) hands each side a snapshot holding one
// vocabulary, so those parts are empty on both sides anyway — the strips are
// there to say WHY, and to answer the list.
//
// What the steps below describe is the file's own doing: a header of field
// names, one row per entry, values as text.

import { STRIPS } from './strips.js';
import { IGT_NAMESPACE as IGT } from '../../../domain/igtConfig.js';
import { FEATURE_KEYS } from '../catalog.js';
import list from '../formats/vocabTsv.js';

/**
 * The vocabulary is the one thing the file IS about, so what it says about the
 * vocabulary itself — that it exists, that a project links it, what its fields
 * are, what it is called — is outside the file without the entries being.
 * The shared strip for these takes the whole vocabulary away, which here would
 * leave nothing to compare.
 */
function onlyTheEntries(s) {
  for (const v of s.vocabularies || []) {
    // The fields stay: the run bulk-adds into a vocabulary that declares the
    // same ones, because Bulk Add maps a column onto a field that exists.
    const fields = v.config?.[IGT]?.fields;
    v.config = fields ? { [IGT]: { fields } } : {};
    v.comments = [];
  }
  for (const d of s.documents || []) d.links = [];
}

/**
 * The sense tree. Every row of the file is an entry, and the column that says
 * which entry is a sense of which (Number) is one Bulk Add ignores, so the tree
 * is not carried: a sense comes back as a headword of its own, or fills the
 * blanks of the headword above it and does not come back at all. The list
 * leaves what SHOULD happen undecided (item.sense, item.subsense,
 * item.containerHeadword), so every entry a tree touches is taken off BOTH
 * sides and neither answer fails.
 */
function flattenSenses(s, ctx) {
  // Which entries are a headword with senses, or a sense: read off the source,
  // since by the time this runs one side has the tree and the other never had
  // it. Spelling is what the two sides have in common.
  const spelled = new Set();
  for (const v of ctx?.source?.vocabularies || []) {
    const byKey = new Map((v.items || []).map((it) => [it.key, it]));
    for (const it of v.items || []) {
      const parent = it.metadata?.parent;
      if (parent == null) continue;
      spelled.add(it.form);
      const head = byKey.get(parent);
      if (head) spelled.add(head.form);
    }
  }
  for (const v of s.vocabularies || []) {
    for (const it of v.items || []) {
      delete it.metadata.parent;
      delete it.metadata.senseOrder;
    }
    if (spelled.size) v.items = (v.items || []).filter((it) => !spelled.has(it.form));
  }
}

/** Nothing outside the vocabulary is in the file, so nothing outside it is compared. */
function notInTheFile(s) {
  s.documents = [];
  s.layers = [];
  s.comments = [];
  s.guidelines = [];
  s.config = {};
}

// Every lost key the shared strips do not already describe is one of the
// things a TSV has no room for, and they all go the same way.
/**
 * An Entry field's values. The export names the entry each reference points at
 * ("gato", "perro 1"), and Bulk Add offers no column for such a field at all
 * (BulkAddDialog.jsx leaves them alone, since they hold references and not
 * text), so nothing of them comes back. The shared strip takes the whole
 * vocabulary instead, which here would leave nothing to compare.
 */
function noEntryFields(s, ctx) {
  const declared = (ctx?.source?.vocabularies || []).flatMap((v) =>
    Object.entries(v.config?.[IGT]?.fields || {})
      .filter(([, spec]) => spec?.type === 'item')
      .map(([name]) => name),
  );
  const names = new Set(declared);
  for (const v of s.vocabularies || []) {
    for (const it of v.items || []) for (const n of names) delete it.metadata[n];
  }
}

const strips = {
  'item.itemRefValue': noEntryFields,
  'item.itemRefManyValue': noEntryFields,
  'item.sense': flattenSenses,
  'item.subsense': flattenSenses,
  'item.containerHeadword': flattenSenses,
  'vocab.linked': onlyTheEntries,
  'vocab.second': onlyTheEntries,
  'vocab.duplicateName': onlyTheEntries,
  'vocab.customField': onlyTheEntries,
  'vocab.fieldNotInline': onlyTheEntries,
  'vocab.fieldTagset': onlyTheEntries,
  'vocab.fieldLang': onlyTheEntries,
  'vocab.fieldMultilingual': onlyTheEntries,
  'vocab.fieldItemRef': onlyTheEntries,
  'vocab.fieldItemRefMany': onlyTheEntries,
  'vocab.fieldEntryScope': onlyTheEntries,
  'vocab.customTagset': onlyTheEntries,
  'vocab.foreignConfig': onlyTheEntries,
};
for (const key of FEATURE_KEYS) {
  const entry = list.features[key];
  if (entry.carried !== false) continue;
  const shared = STRIPS[key];
  if (typeof shared === 'function' || shared?.coveredBy) continue;
  strips[key] = notInTheFile;
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);

/** Every entry of every vocabulary, for a step that works one row at a time. */
const items = (s) => (s.vocabularies || []).flatMap((v) => v.items || []);

export default {
  id: 'vocabTsv',
  strips,
  steps: [
    {
      keys: ['item.markupChars', 'item.surroundingWhitespace', 'item.formNormalization'],
      // A cell is text: a tab or a line break in a value becomes a space
      // (tsvCell in src/export/vocabTsv.js), and Bulk Add trims what it reads,
      // so a value padded with spaces comes back without them. Markup
      // characters are text like any other and come back as they were.
      apply(expected) {
        for (const it of items(expected)) {
          it.form = String(it.form ?? '')
            .replace(/[\t\r\n]+/g, ' ')
            .trim();
          for (const [k, v] of Object.entries(it.metadata)) {
            if (typeof v !== 'string') continue;
            it.metadata[k] = trimmed(v.replace(/[\t\r\n]+/g, ' '));
          }
        }
        // A row whose form is left empty is no entry at all.
        for (const v of expected.vocabularies || []) {
          v.items = (v.items || []).filter((it) => it.form !== '');
        }
      },
    },
    {
      keys: ['item.homonyms'],
      // Two entries spelled alike are two rows, and the row that disagrees
      // with the entry an earlier row made is answered "add", so both come
      // back. A row that only AGREES with one — every value it has is that
      // entry's, and the rest are blank — is not a second entry at all: Bulk
      // Add takes it for the same one and offers no answer that would make it
      // another. What never comes back is which was which, since the number
      // that tells them apart is the target vocabulary's own.
      apply(expected) {
        for (const it of items(expected)) delete it.metadata.homograph;
        for (const v of expected.vocabularies || []) {
          const kept = [];
          for (const it of v.items || []) {
            const agreesWith = kept.find(
              (earlier) =>
                earlier.form === it.form &&
                Object.entries(it.metadata).every(([k, value]) => earlier.metadata[k] === value),
            );
            if (!agreesWith) kept.push(it);
          }
          v.items = kept;
        }
      },
    },
  ],
};
