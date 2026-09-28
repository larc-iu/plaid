// Repairs two classes of broken roleset ids in UMR-Writer's frames_arabic.json
// and writes the result to arabic.json beside this script, with every changed
// id in arabic-renames.json (old id to new id).
//
//   curl -sSfLO https://raw.githubusercontent.com/umr4nlp/umr-annotation-tool/master/umr_annot_tool/resources/frames_arabic.json
//   curl -sSfLO https://raw.githubusercontent.com/umr4nlp/umr-annotation-tool/master/umr_annot_tool/resources/arabic-propbank1.json
//   node src/data/frames/fix-arabic.mjs frames_arabic.json [arabic-propbank1.json]
//
// Upstream built its ids from the Arabic PropBank's Buckwalter names
// (arabic-propbank1.json keys them `نَزَح-01-nazaH-ai-v`), and two things went
// wrong on the way back to Arabic script:
//
// 1. Six letters stayed Latin. That PropBank writes أ إ آ ؤ ذ ء as O I M W X L
//    (not Buckwalter's > < | & * '), which the conversion did not know, so
//    تذكير is keyed `تXكير-01` and no typed word finds it. The file has not one
//    of those six Arabic letters, and each maps back to exactly one of them.
// 2. A verb's vowel class (`-ai`, `-ui`) is all short vowels, which became
//    diacritics and were stripped, leaving `نزح--01`. The id's lemma then reads
//    `نزح-`, and the word نزح is never offered it.
//
// A roleset whose repaired id is already taken is dropped for the one there
// if the two have the same arguments, and otherwise keeps its old id, less
// any Latin letters (أثر-01 and أثر--01 are different verbs of one root).
// Anything else Latin (six ids spelling English words, `دeفeند-01`) is left
// as it is. Both are listed on the way out. Given arabic-propbank1.json, it also counts how
// many repaired ids that file confirms: same lemma, sense and arguments.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const LATIN_LETTERS = {
  O: '\u0623', // أ
  I: '\u0625', // إ
  M: '\u0622', // آ
  W: '\u0624', // ؤ
  X: '\u0630', // ذ
  L: '\u0621', // ء
};

// A key's lemma and sense: `نزح--01` is `نزح-` and `01`.
const split = (id) => {
  const at = id.lastIndexOf('-');
  return [id.slice(0, at), id.slice(at + 1)];
};

// The lemma with its known Latin letters in Arabic, or null when any other
// Latin letter is left.
const arabicLemma = (lemma) => {
  const out = lemma.replace(/[OIMWXL]/g, (c) => LATIN_LETTERS[c]);
  return /[A-Za-z]/.test(out) ? null : out;
};

const sameArgs = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Python's json.dump(indent=2) with ensure_ascii, which upstream writes, so a
// rerun on an unchanged file changes nothing and the diff shows only the ids.
const serialize = (obj) =>
  JSON.stringify(obj, null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

export function repair(upstream) {
  // Each id's repair, and what it keeps if that id is another roleset's: the
  // letters alone for a doubled hyphen, else the id as it is.
  const plans = Object.keys(upstream).map((id) => {
    const [lemma, sense] = split(id);
    const lettered = /[A-Za-z]/.test(lemma) ? arabicLemma(lemma) : lemma;
    if (lettered === null) return { id, repaired: id, fallback: id, latin: true };
    const repaired = lemma.endsWith('-')
      ? `${lettered.slice(0, -1)}-${sense}`
      : `${lettered}-${sense}`;
    return { id, repaired, fallback: lemma.endsWith('-') ? `${lettered}-${sense}` : id };
  });
  // Ids already right first, then letters, then doubled hyphens, so a repair
  // never takes the id of a roleset that already had it.
  const rank = (p) => (p.repaired === p.id ? 0 : p.id.includes('--') ? 2 : 1);
  const holder = new Map();
  const placed = new Map();
  const renamed = new Map();
  const leftLatin = plans.filter((p) => p.latin).map((p) => p.id);
  const leftTaken = [];
  [...plans]
    .sort((a, b) => rank(a) - rank(b))
    .forEach(({ id, repaired, fallback }) => {
      const there = holder.get(repaired);
      let next = repaired;
      if (there !== undefined && sameArgs(upstream[there], upstream[id])) {
        renamed.set(id, repaired);
        return;
      }
      if (there !== undefined) {
        next = fallback;
        leftTaken.push(id);
        if (holder.has(next)) throw new Error(`${id}: both ${repaired} and ${next} are taken`);
      }
      holder.set(next, id);
      placed.set(id, next);
      if (next !== id) renamed.set(id, next);
    });
  // Upstream's order, less the merged.
  const frames = {};
  const renames = {};
  Object.keys(upstream).forEach((id) => {
    if (placed.has(id)) frames[placed.get(id)] = upstream[id];
    if (renamed.has(id)) renames[id] = renamed.get(id);
  });
  const order = new Map(Object.keys(upstream).map((id, i) => [id, i]));
  leftTaken.sort((a, b) => order.get(a) - order.get(b));
  return { frames, renames, leftLatin, leftTaken };
}

// How many renamed ids arabic-propbank1.json holds with the same arguments.
function confirmed(renames, upstream, propbank) {
  const index = new Map();
  Object.entries(propbank).forEach(([key, { desc, ...args }]) => {
    const [lemma, sense] = key.split('-');
    const k = `${lemma.replace(/[\u064b-\u0652]/g, '')}-${sense}`;
    index.set(k, [...(index.get(k) || []), args]);
  });
  const miss = Object.entries(renames).filter(([old, id]) => {
    // An id left with its doubled hyphen is found without it.
    const found = index.get(id.replace('--', '-')) || [];
    return !found.some((a) => sameArgs(a, upstream[old]));
  });
  return miss.map(([old]) => old);
}

const main = () => {
  const [source, propbankFile] = process.argv.slice(2);
  if (!source) {
    console.error('usage: node fix-arabic.mjs frames_arabic.json [arabic-propbank1.json]');
    process.exit(2);
  }
  const upstream = JSON.parse(readFileSync(source, 'utf8'));
  const { frames, renames, leftLatin, leftTaken } = repair(upstream);
  writeFileSync(path.join(HERE, 'arabic.json'), serialize(frames));
  writeFileSync(path.join(HERE, 'arabic-renames.json'), serialize(renames) + '\n');
  const merged = Object.keys(upstream).length - Object.keys(frames).length;
  console.log(`rolesets: ${Object.keys(upstream).length} in, ${Object.keys(frames).length} out`);
  console.log(
    `renamed: ${Object.keys(renames).length - merged}, merged into an identical roleset: ${merged}`,
  );
  console.log(`left with Latin letters (${leftLatin.length}): ${leftLatin.join(' ')}`);
  console.log(`left, repaired id taken (${leftTaken.length}): ${leftTaken.join(' ')}`);
  if (propbankFile) {
    const miss = confirmed(renames, upstream, JSON.parse(readFileSync(propbankFile, 'utf8')));
    console.log(
      `confirmed by ${path.basename(propbankFile)}: ${Object.keys(renames).length - miss.length}`,
    );
    console.log(`not found there (${miss.length}): ${miss.join(' ')}`);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
